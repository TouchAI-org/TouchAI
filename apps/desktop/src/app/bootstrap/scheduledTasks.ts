import { z } from 'zod';

import { type ScheduledTasksApi, ScheduledTasksError } from '@/app/api/scheduler/administration';
import { SchedulerError, type TaskScheduler } from '@/modules/scheduler/public';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

const REQUEST_EVENT = 'scheduled-tasks:request';
const REPLY_EVENT = 'scheduled-tasks:reply';
const TIMEOUT_MS = 5_000;
const LIMIT = 8;

const trigger = z.discriminatedUnion('type', [
    z.strictObject({
        type: z.literal('cron'),
        expression: z.string().trim().min(1).max(200),
    }),
    z.strictObject({
        type: z.literal('once'),
        timestamp: z.number().int().positive(),
    }),
    z.strictObject({
        type: z.literal('interval'),
        milliseconds: z.number().int().positive(),
    }),
]);
const draft = z.strictObject({
    name: z.string(),
    prompt: z.string(),
    trigger,
    timezone: z.string().optional(),
    modelId: z.string().optional(),
    providerId: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
});
const update = draft.partial().omit({}).strict();
const commands = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('list') }),
    z.strictObject({ operation: z.literal('create'), data: draft }),
    z.strictObject({
        operation: z.literal('update'),
        taskId: z.string().min(1),
        data: update,
    }),
    z.strictObject({ operation: z.literal('remove'), taskId: z.string().min(1) }),
    z.strictObject({ operation: z.literal('runs'), taskId: z.string().min(1) }),
]);
type Command = z.infer<typeof commands>;

const taskSchema = z.object({
    id: z.string(),
    name: z.string(),
    prompt: z.string(),
    trigger,
    timezone: z.string(),
    modelId: z.string().optional(),
    providerId: z.number().int().positive().optional(),
    enabled: z.boolean(),
    lastRunAt: z.number().int().nullable(),
    nextRunAt: z.number().int().nullable(),
    version: z.number().int().positive(),
    deletedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
});
const runSchema = z.object({
    id: z.string(),
    scheduleId: z.string(),
    scheduleVersion: z.number().int().positive(),
    scheduledFor: z.number().int(),
    startedAt: z.number().int().nullable(),
    finishedAt: z.number().int().nullable(),
    outcome: z
        .enum(['completed', 'failed', 'cancelled', 'skipped_overlap', 'missed', 'skipped_dst'])
        .nullable(),
    reason: z.string().nullable(),
    backgroundTaskId: z.string().nullable(),
    sessionId: z.number().int().nullable(),
    turnId: z.number().int().nullable(),
    createdAt: z.number().int(),
});
const resultSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('tasks'), value: z.array(taskSchema) }),
    z.strictObject({ kind: z.literal('task'), value: taskSchema }),
    z.strictObject({ kind: z.literal('removed'), value: z.boolean() }),
    z.strictObject({ kind: z.literal('runs'), value: z.array(runSchema) }),
]);
const requestSchema = z.strictObject({
    requestId: z.uuid(),
    from: z.literal('settings'),
    command: commands,
});
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(true),
        result: resultSchema,
    }),
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(false),
        code: z.enum([
            'SCHEDULED_TASKS_UNAVAILABLE',
            'SCHEDULED_TASKS_UNCONFIRMED',
            'SCHEDULED_TASKS_FAILED',
            'SCHEDULE_INVALID_INPUT',
        ]),
        outcome: z.enum(['none', 'unknown']),
    }),
]);
type Reply = z.infer<typeof replySchema>;

function publicError(error: unknown): ScheduledTasksError {
    if (error instanceof ScheduledTasksError) return error;
    if (error instanceof SchedulerError && error.code === 'SCHEDULE_INVALID_INPUT') {
        return new ScheduledTasksError('SCHEDULE_INVALID_INPUT');
    }
    return new ScheduledTasksError('SCHEDULED_TASKS_FAILED', 'unknown');
}

/** Main owns the scheduler; settings receives a validated request/reply projection. */
export function createScheduledTasksWindow(input: {
    label: string | null;
    signal: AbortSignal;
    owner?(signal: AbortSignal): Promise<TaskScheduler>;
    warn(code: string): void;
}) {
    const supported = input.label === 'main' || input.label === 'settings';
    const pending = new Map<string, (reply: Reply) => void>();
    const served = new Map<
        string,
        { command: string; completion: Promise<Reply>; completedAt?: number }
    >();
    let disposed = input.signal.aborted;
    let stop: (() => void) | undefined;
    let running = 0;

    const warn = () => {
        try {
            input.warn('SCHEDULED_TASKS_FAILED');
        } catch {
            // Passive diagnostics cannot change the reply.
        }
    };
    const failure = (requestId: string, error: ScheduledTasksError): Reply => ({
        requestId,
        ok: false,
        code: error.code,
        outcome: error.outcome,
    });

    async function invoke(scheduler: TaskScheduler, command: Command) {
        await scheduler.initialize();
        switch (command.operation) {
            case 'list':
                return { kind: 'tasks' as const, value: scheduler.getAllTasks() };
            case 'create':
                return {
                    kind: 'task' as const,
                    value: await scheduler.addTask(command.data),
                };
            case 'update': {
                const value = await scheduler.updateTask(command.taskId, command.data);
                if (!value) {
                    throw new ScheduledTasksError('SCHEDULED_TASKS_FAILED', 'none');
                }
                return { kind: 'task' as const, value };
            }
            case 'remove':
                return {
                    kind: 'removed' as const,
                    value: await scheduler.removeTask(command.taskId),
                };
            case 'runs':
                return {
                    kind: 'runs' as const,
                    value: await scheduler.getRuns(command.taskId),
                };
        }
    }

    async function run(command: Command) {
        if (disposed || !input.owner || running >= LIMIT) {
            throw new ScheduledTasksError('SCHEDULED_TASKS_UNAVAILABLE', 'none');
        }
        running += 1;
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(new ScheduledTasksError('SCHEDULED_TASKS_UNCONFIRMED', 'unknown')),
            TIMEOUT_MS
        );
        const combined = combineAbortSignals([input.signal, deadline.signal]);
        try {
            return await awaitAbortable(async () => {
                const scheduler = await input.owner!(combined.signal);
                combined.signal.throwIfAborted();
                return resultSchema.parse(await invoke(scheduler, command));
            }, combined.signal);
        } catch (error) {
            throw publicError(error);
        } finally {
            combined.dispose();
            clearTimeout(timer);
            running -= 1;
        }
    }

    async function serve(payload: unknown) {
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success || disposed) return;
        const request = parsed.data;
        const now = Date.now();
        for (const [key, value] of served) {
            if (value.completedAt !== undefined && now - value.completedAt >= 300_000) {
                served.delete(key);
            }
        }
        const command = JSON.stringify(request.command);
        let entry = served.get(request.requestId);
        if (entry && entry.command !== command) return;
        if (!entry) {
            if (served.size >= 64) {
                for (const [key, value] of served) {
                    if (value.completedAt !== undefined) {
                        served.delete(key);
                        break;
                    }
                }
            }
            if (served.size >= 64) {
                await emitWindowEvent(
                    request.from,
                    REPLY_EVENT,
                    failure(
                        request.requestId,
                        new ScheduledTasksError('SCHEDULED_TASKS_UNAVAILABLE')
                    )
                ).catch(warn);
                return;
            }
            entry = {
                command,
                completion: run(request.command).then(
                    (result): Reply => ({
                        requestId: request.requestId,
                        ok: true,
                        result,
                    }),
                    (error: ScheduledTasksError) => failure(request.requestId, error)
                ),
            };
            served.set(request.requestId, entry);
            const current = entry;
            void entry.completion.then(() => {
                current.completedAt = Date.now();
            });
        }
        const reply = await entry.completion;
        if (!disposed) await emitWindowEvent(request.from, REPLY_EVENT, reply).catch(warn);
    }

    const ready = supported
        ? listenWindowEvent(
              input.label!,
              input.label === 'main' ? REQUEST_EVENT : REPLY_EVENT,
              (payload) => {
                  if (input.label === 'main') {
                      void serve(payload).catch(warn);
                      return;
                  }
                  const parsed = replySchema.safeParse(payload);
                  if (parsed.success) pending.get(parsed.data.requestId)?.(parsed.data);
              }
          ).then((unlisten) => {
              if (disposed) unlisten();
              else stop = unlisten;
          })
        : Promise.resolve();
    void ready.catch(warn);

    async function request(command: Command) {
        if (
            disposed ||
            input.label !== 'settings' ||
            !commands.safeParse(command).success ||
            pending.size >= LIMIT
        ) {
            throw new ScheduledTasksError('SCHEDULED_TASKS_UNAVAILABLE');
        }
        const requestId = crypto.randomUUID();
        return new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
            const finish = (reply: Reply) => {
                if (!pending.delete(requestId)) return;
                clearTimeout(timer);
                if (reply.ok) resolve(reply.result);
                else reject(new ScheduledTasksError(reply.code, reply.outcome));
            };
            const timer = setTimeout(
                () =>
                    finish(
                        failure(
                            requestId,
                            new ScheduledTasksError('SCHEDULED_TASKS_UNCONFIRMED', 'unknown')
                        )
                    ),
                TIMEOUT_MS
            );
            pending.set(requestId, finish);
            void ready
                .then(async () => {
                    if (pending.has(requestId)) {
                        await emitWindowEvent('main', REQUEST_EVENT, {
                            requestId,
                            from: 'settings',
                            command,
                        });
                    }
                })
                .catch(() =>
                    finish(
                        failure(requestId, new ScheduledTasksError('SCHEDULED_TASKS_UNAVAILABLE'))
                    )
                );
        });
    }

    async function expectKind<K extends z.infer<typeof resultSchema>['kind']>(
        command: Command,
        kind: K
    ) {
        const result = await request(command);
        if (result.kind !== kind) {
            throw new ScheduledTasksError('SCHEDULED_TASKS_FAILED', 'unknown');
        }
        return result as Extract<z.infer<typeof resultSchema>, { kind: K }>;
    }

    const api = Object.freeze<ScheduledTasksApi>({
        async list() {
            return (await expectKind({ operation: 'list' }, 'tasks')).value;
        },
        async create(data) {
            return (await expectKind({ operation: 'create', data }, 'task')).value;
        },
        async update(taskId, data) {
            return (await expectKind({ operation: 'update', taskId, data }, 'task')).value;
        },
        async remove(taskId) {
            return (await expectKind({ operation: 'remove', taskId }, 'removed')).value;
        },
        async runs(taskId) {
            return (await expectKind({ operation: 'runs', taskId }, 'runs')).value;
        },
    });

    function dispose() {
        if (disposed) return;
        disposed = true;
        stop?.();
        stop = undefined;
        for (const [requestId, finish] of [...pending]) {
            finish(
                failure(
                    requestId,
                    new ScheduledTasksError('SCHEDULED_TASKS_UNCONFIRMED', 'unknown')
                )
            );
        }
        served.clear();
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, ready, dispose });
}
