// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { MemorySchedulerRepository } from './memoryRepository';
import { findSkippedDstOccurrences, isValidTimezone, nextCronOccurrence } from './time';
import type {
    EventTrigger,
    ScheduledTask,
    ScheduledTaskRun,
    ScheduledTaskRunOutcome,
    SchedulerCompletion,
    SchedulerExecution,
    SchedulerRepository,
    ScheduleTrigger,
} from './types';

const CATCH_UP_GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 2_147_000_000;
const MAX_ERROR_SUMMARY_LENGTH = 500;

interface ScheduleBinding {
    state: 'pending' | 'armed' | 'disposed';
    version: number;
    cleanup: (() => void) | null;
}

type SchedulerRunResult = SchedulerExecution | void;

export interface SchedulerHost {
    run(input: {
        prompt: string;
        modelId?: string;
        providerId?: number;
    }): Promise<SchedulerRunResult> | SchedulerRunResult;
    listen(trigger: EventTrigger, callback: () => void): Promise<() => void>;
    diagnostics: { warn(message: string): void; error(message: string, error: unknown): void };
}

export type ScheduledTaskErrorCode = 'SCHEDULE_INVALID_INPUT';

export class SchedulerError extends Error {
    constructor(
        readonly code: ScheduledTaskErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'SchedulerError';
    }
}

export interface CreateScheduledTaskInput {
    name: string;
    prompt: string;
    trigger: ScheduleTrigger;
    timezone?: string;
    modelId?: string;
    providerId?: number;
    enabled?: boolean;
}

export interface UpdateScheduledTaskInput {
    name?: string;
    prompt?: string;
    trigger?: ScheduleTrigger;
    timezone?: string;
    modelId?: string;
    providerId?: number;
    enabled?: boolean;
}

export interface TaskSchedulerOptions extends SchedulerHost {
    repository?: SchedulerRepository;
    now?: () => number;
    createId?: () => string;
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
    notifyFailure?: (input: { scheduleId: string; scheduleName: string; reason: string }) => void;
}

function cloneValue<T>(value: T): T {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Scheduler inputs can come from Vue state; the JSON fallback handles proxies.
        }
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

function defaultTimezone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function nonEmpty(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new SchedulerError('SCHEDULE_INVALID_INPUT', `${label} is required`);
    }
    return normalized;
}

function compactError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, MAX_ERROR_SUMMARY_LENGTH);
}

function isCancellation(error: unknown): boolean {
    return (
        (error instanceof Error && error.name === 'AbortError') ||
        (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'REQUEST_CANCELLED' || error.code === 'REQUEST_CANCELLED_BY_USER'))
    );
}

/**
 * Owns scheduling and scheduling history only. Agent execution state remains in
 * the shared session/turn/attempt owner.
 */
export class TaskScheduler {
    private readonly tasks = new Map<string, ScheduledTask>();
    private readonly scheduleBindings = new Map<string, ScheduleBinding>();
    private readonly runningTasks = new Set<string>();
    private readonly failedStreaks = new Set<string>();
    private readonly taskMutations = new Map<string, Promise<unknown>>();
    private readonly repository: SchedulerRepository;
    private readonly now: () => number;
    private readonly createId: () => string;
    private readonly setTimer: NonNullable<TaskSchedulerOptions['setTimer']>;
    private readonly clearTimer: NonNullable<TaskSchedulerOptions['clearTimer']>;
    private initialization: Promise<void> | null = null;
    private disposed = false;

    constructor(private readonly host: TaskSchedulerOptions) {
        this.repository = host.repository ?? new MemorySchedulerRepository();
        this.now = host.now ?? Date.now;
        this.createId = host.createId ?? (() => crypto.randomUUID());
        this.setTimer =
            host.setTimer ??
            ((callback, delayMs) => {
                if (delayMs <= MAX_TIMEOUT_MS) return setTimeout(callback, delayMs);
                return setTimeout(callback, MAX_TIMEOUT_MS);
            });
        this.clearTimer = host.clearTimer ?? clearTimeout;
    }

    initialize(): Promise<void> {
        if (!this.initialization) this.initialization = this.reconcile();
        return this.initialization;
    }

    async addTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
        if (this.disposed) throw new Error('SCHEDULER_DISPOSED');
        const now = this.now();
        const task: ScheduledTask = {
            id: this.createId(),
            name: nonEmpty(input.name, 'Schedule name'),
            prompt: nonEmpty(input.prompt, 'Prompt'),
            trigger: cloneValue(input.trigger),
            timezone: input.timezone ?? defaultTimezone(),
            modelId: input.modelId,
            providerId: input.providerId,
            enabled: input.enabled ?? true,
            lastRunAt: null,
            nextRunAt: null,
            version: 1,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
        };
        this.validateTask(task, { requireFutureOnce: true });
        task.nextRunAt = task.enabled
            ? this.calculateNextRun(task.trigger, new Date(now), task.timezone)
            : null;

        this.tasks.set(task.id, task);
        try {
            await this.repository.insertTask(task);
            await this.armTask(task);
            return cloneValue(task);
        } catch (error) {
            this.tasks.delete(task.id);
            this.clearTaskResources(task.id);
            this.runningTasks.delete(task.id);
            try {
                await this.repository.updateTask({
                    ...task,
                    enabled: false,
                    nextRunAt: null,
                    deletedAt: this.now(),
                    updatedAt: this.now(),
                });
            } catch {
                // Preserve the original validation or scheduling failure.
            }
            throw error;
        }
    }

    getAllTasks(): ScheduledTask[] {
        return [...this.tasks.values()]
            .filter((task) => task.deletedAt === null)
            .map((task) => cloneValue(task));
    }

    getTask(taskId: string): ScheduledTask | undefined {
        const task = this.tasks.get(taskId);
        return task && task.deletedAt === null ? cloneValue(task) : undefined;
    }

    async updateTask(
        taskId: string,
        updates: UpdateScheduledTaskInput
    ): Promise<ScheduledTask | undefined> {
        return this.serializeTaskMutation(taskId, async () => {
            const existingTask = this.tasks.get(taskId);
            if (!existingTask || existingTask.deletedAt !== null) {
                return undefined;
            }

            const previousTask = cloneValue(existingTask);
            const changesTrigger = updates.trigger !== undefined;
            const changesOnceTimestamp =
                updates.trigger?.type === 'once' &&
                (existingTask.trigger.type !== 'once' ||
                    updates.trigger.timestamp !== existingTask.trigger.timestamp);
            const nextTask: ScheduledTask = {
                ...existingTask,
                ...updates,
                name: updates.name ?? existingTask.name,
                prompt: updates.prompt ?? existingTask.prompt,
                trigger: cloneValue(updates.trigger ?? existingTask.trigger),
                timezone: updates.timezone ?? existingTask.timezone,
                enabled:
                    updates.enabled ??
                    (changesTrigger && existingTask.trigger.type === 'once'
                        ? true
                        : existingTask.enabled),
                nextRunAt: null,
                version: existingTask.version + 1,
                updatedAt: this.now(),
            };
            this.validateTask(nextTask, {
                requireFutureOnce: changesOnceTimestamp || nextTask.enabled,
            });
            nextTask.nextRunAt = nextTask.enabled
                ? this.calculateNextRun(nextTask.trigger, new Date(this.now()), nextTask.timezone)
                : null;
            this.tasks.set(taskId, nextTask);

            try {
                await this.repository.updateTask(nextTask);
                await this.armTask(nextTask);
                return cloneValue(nextTask);
            } catch (error) {
                this.clearTaskResources(taskId);
                this.tasks.set(taskId, previousTask);
                try {
                    await this.repository.updateTask(previousTask);
                    await this.armTask(previousTask);
                } catch (rollbackError) {
                    this.host.diagnostics.error(
                        `[TaskScheduler] Failed to roll back schedule ${taskId}`,
                        rollbackError
                    );
                }
                throw error;
            }
        });
    }

    async removeTask(taskId: string): Promise<boolean> {
        return this.serializeTaskMutation(taskId, async () => {
            const task = this.tasks.get(taskId);
            if (!task || task.deletedAt !== null) return false;

            const deleted: ScheduledTask = {
                ...task,
                enabled: false,
                nextRunAt: null,
                version: task.version + 1,
                deletedAt: this.now(),
                updatedAt: this.now(),
            };
            await this.repository.updateTask(deleted);
            this.clearTaskResources(taskId);
            this.tasks.delete(taskId);
            this.runningTasks.delete(taskId);
            this.failedStreaks.delete(taskId);
            return true;
        });
    }

    async scheduleTask(taskId: string): Promise<void> {
        if (this.disposed) throw new Error('SCHEDULER_DISPOSED');
        const task = this.tasks.get(taskId);
        if (!task) return;
        await this.armTask(task);
    }

    unscheduleTask(taskId: string): void {
        this.clearTaskResources(taskId);
        const task = this.tasks.get(taskId);
        if (!task) return;
        task.nextRunAt = null;
        task.updatedAt = this.now();
        void this.repository.updateTask(task).catch((error: unknown) => {
            this.host.diagnostics.error(
                `[TaskScheduler] Failed to persist unscheduled task ${taskId}`,
                error
            );
        });
    }

    calculateNextRun(
        trigger: ScheduleTrigger,
        from: Date = new Date(this.now()),
        timezone = defaultTimezone()
    ): number | null {
        switch (trigger.type) {
            case 'interval': {
                if (!Number.isFinite(trigger.milliseconds) || trigger.milliseconds <= 0) {
                    throw new SchedulerError(
                        'SCHEDULE_INVALID_INPUT',
                        'Interval trigger milliseconds must be greater than 0'
                    );
                }
                return from.getTime() + trigger.milliseconds;
            }
            case 'once': {
                if (!Number.isFinite(trigger.timestamp)) {
                    throw new SchedulerError(
                        'SCHEDULE_INVALID_INPUT',
                        'Once trigger timestamp must be a valid number'
                    );
                }
                return trigger.timestamp;
            }
            case 'cron': {
                try {
                    return nextCronOccurrence(trigger, timezone, from);
                } catch (error) {
                    throw new SchedulerError('SCHEDULE_INVALID_INPUT', compactError(error));
                }
            }
            case 'event':
                return null;
            default:
                return null;
        }
    }

    async executeTask(taskId: string, expectedScheduleVersion?: number): Promise<void> {
        const task = this.tasks.get(taskId);
        if (this.disposed || !task || !task.enabled || task.deletedAt !== null) return;
        if (expectedScheduleVersion !== undefined && expectedScheduleVersion !== task.version) {
            return;
        }
        await this.fireDue(taskId, task.version, task.nextRunAt ?? this.now(), false);
    }

    async getRuns(scheduleId: string): Promise<ScheduledTaskRun[]> {
        return this.repository.listRuns(scheduleId);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const taskId of [...this.scheduleBindings.keys()]) {
            this.clearTaskResources(taskId);
        }
        this.tasks.clear();
        this.runningTasks.clear();
        this.failedStreaks.clear();
    }

    private async reconcile(): Promise<void> {
        if (this.disposed) throw new Error('SCHEDULER_DISPOSED');
        const now = this.now();
        const activeRuns = await this.repository.listActiveRuns();
        for (const run of activeRuns) {
            await this.repository.updateRun(run.id, {
                outcome: 'failed',
                finishedAt: now,
                reason: 'interrupted_during_restart',
            });
        }

        const stored = await this.repository.listTasks();
        for (const task of stored) {
            this.tasks.set(task.id, cloneValue(task));
        }

        for (const task of this.tasks.values()) {
            if (task.deletedAt !== null) continue;
            if (!task.enabled) {
                if (task.nextRunAt !== null) {
                    task.nextRunAt = null;
                    task.updatedAt = now;
                    await this.repository.updateTask(task);
                }
                continue;
            }

            await this.recordDstGaps(task, now);

            if (task.trigger.type === 'once') {
                const scheduledFor = task.trigger.timestamp;
                if (scheduledFor > now) {
                    task.nextRunAt = scheduledFor;
                    await this.repository.updateTask(task);
                    await this.armTask(task);
                } else if (now - scheduledFor <= CATCH_UP_GRACE_MS) {
                    await this.fireDue(task.id, task.version, scheduledFor, true);
                } else {
                    await this.recordEvidence(
                        task,
                        scheduledFor,
                        'missed',
                        'catch_up_grace_expired'
                    );
                    await this.disableOneTimeTask(task);
                }
                continue;
            }

            const dueAt = task.nextRunAt;
            if (dueAt !== null && dueAt <= now) {
                await this.recordEvidence(task, dueAt, 'missed', 'coalesced_while_app_closed');
                await this.advanceTask(task, dueAt, now);
            } else if (dueAt === null && task.trigger.type !== 'event') {
                task.nextRunAt = this.calculateNextRun(task.trigger, new Date(now), task.timezone);
                task.updatedAt = now;
                await this.repository.updateTask(task);
            }
            await this.armTask(task);
        }
    }

    private validateTask(task: ScheduledTask, options: { requireFutureOnce: boolean }): void {
        nonEmpty(task.name, 'Schedule name');
        nonEmpty(task.prompt, 'Prompt');
        if (!isValidTimezone(task.timezone)) {
            throw new SchedulerError(
                'SCHEDULE_INVALID_INPUT',
                `Unknown IANA timezone: ${task.timezone}`
            );
        }
        if (
            task.trigger.type === 'once' &&
            options.requireFutureOnce &&
            task.trigger.timestamp <= this.now()
        ) {
            throw new SchedulerError(
                'SCHEDULE_INVALID_INPUT',
                'One-time schedule must be in the future'
            );
        }
        this.calculateNextRun(task.trigger, new Date(this.now()), task.timezone);
    }

    private async armTask(task: ScheduledTask): Promise<void> {
        if (this.disposed || task.enabled === false || task.deletedAt !== null) {
            this.clearTaskResources(task.id);
            return;
        }
        const version = task.version;
        this.clearTaskResources(task.id);
        this.scheduleBindings.set(task.id, {
            state: 'pending',
            version,
            cleanup: null,
        });

        if (task.trigger.type === 'event') {
            const cleanup = await this.host.listen(task.trigger, () => {
                if (this.isCurrentVersion(task.id, version)) {
                    void this.fireDue(task.id, version, this.now(), false);
                }
            });
            this.attachResource(task.id, version, cleanup);
            return;
        }

        let nextRunAt = task.nextRunAt;
        if (nextRunAt === null) {
            nextRunAt = this.calculateNextRun(task.trigger, new Date(this.now()), task.timezone);
        }
        task.nextRunAt = nextRunAt;
        if (nextRunAt === null) return;

        const delay = Math.max(nextRunAt - this.now(), 0);
        const timeout = this.setTimer(() => {
            if (!this.isCurrentVersion(task.id, version)) return;
            if (delay >= MAX_TIMEOUT_MS) {
                void this.armTask(task);
                return;
            }
            void this.fireDue(task.id, version, nextRunAt!, false);
        }, delay);
        this.attachResource(task.id, version, () => this.clearTimer(timeout));
    }

    private async fireDue(
        taskId: string,
        expectedVersion: number,
        scheduledFor: number,
        delayedCatchUp: boolean
    ): Promise<void> {
        const prepared = await this.serializeTaskMutation(taskId, async () => {
            let run: ScheduledTaskRun | null = null;
            const task = this.tasks.get(taskId);
            if (
                this.disposed ||
                !task ||
                !task.enabled ||
                task.deletedAt !== null ||
                !this.isCurrentVersion(taskId, expectedVersion)
            ) {
                return null;
            }

            const now = this.now();
            await this.recordDstGaps(task, now);

            // Claim the schedule before querying run state. Task edits and
            // deletes serialize behind this claim, so an edit cannot be
            // overwritten by advancing an older schedule snapshot.
            if (this.runningTasks.has(taskId)) {
                await this.recordEvidence(
                    task,
                    scheduledFor,
                    'skipped_overlap',
                    'previous_run_active'
                );
                await this.advanceTask(task, scheduledFor, now);
                await this.armTask(task);
                return null;
            }
            this.runningTasks.add(taskId);

            let claimedHere = true;
            try {
                const active = await this.repository.findActiveRun(taskId);
                if (active) {
                    this.runningTasks.delete(taskId);
                    claimedHere = false;
                    await this.recordEvidence(
                        task,
                        scheduledFor,
                        'skipped_overlap',
                        'previous_run_active'
                    );
                    await this.advanceTask(task, scheduledFor, now);
                    await this.armTask(task);
                    return null;
                }

                const snapshot = cloneValue(task);
                run = {
                    id: this.createId(),
                    scheduleId: snapshot.id,
                    scheduleVersion: snapshot.version,
                    scheduledFor,
                    startedAt: now,
                    finishedAt: null,
                    outcome: null,
                    reason: delayedCatchUp ? 'delayed_catch_up' : null,
                    backgroundTaskId: null,
                    sessionId: null,
                    turnId: null,
                    createdAt: now,
                };
                const inserted = await this.repository.insertRun(run);
                if (!inserted) {
                    run = null;
                    this.runningTasks.delete(taskId);
                    claimedHere = false;
                    await this.advanceTask(task, scheduledFor, now);
                    await this.armTask(task);
                    return null;
                }

                task.lastRunAt = now;
                await this.advanceTask(task, scheduledFor, now);
                await this.armTask(task);
                claimedHere = false;
                return { snapshot, run };
            } catch (error) {
                if (!claimedHere) throw error;
                this.runningTasks.delete(taskId);
                if (run) {
                    const failedRun = run;
                    void this.completeRun(cloneValue(task), failedRun, {
                        outcome: 'failed',
                        sessionId: null,
                        turnId: null,
                        errorSummary: compactError(error),
                    }).catch((completionError: unknown) =>
                        this.host.diagnostics.error(
                            `[TaskScheduler] Failed to record run start failure ${failedRun.id}`,
                            completionError
                        )
                    );
                }
                throw error;
            }
        });
        if (!prepared) return;

        const { snapshot, run } = prepared;

        try {
            const started = await this.host.run({
                prompt: snapshot.prompt,
                modelId: snapshot.modelId,
                providerId: snapshot.providerId,
            });
            if (!started) {
                this.runningTasks.delete(taskId);
                await this.completeRun(snapshot, run, {
                    outcome: 'completed',
                    sessionId: null,
                    turnId: null,
                    errorSummary: null,
                });
                return;
            }
            await this.repository.updateRun(run.id, {
                backgroundTaskId: started.backgroundTaskId,
                sessionId: started.sessionId,
            });
            void started.completion
                .then((completion) => this.completeRun(snapshot, run, completion))
                .catch((error: unknown) =>
                    this.completeRun(snapshot, run, {
                        outcome: isCancellation(error) ? 'cancelled' : 'failed',
                        sessionId: started.sessionId,
                        turnId: null,
                        errorSummary: compactError(error),
                    })
                );
        } catch (error) {
            this.runningTasks.delete(taskId);
            await this.completeRun(snapshot, run, {
                outcome: 'failed',
                sessionId: null,
                turnId: null,
                errorSummary: compactError(error),
            });
        }
    }

    private async completeRun(
        task: ScheduledTask,
        run: ScheduledTaskRun,
        completion: SchedulerCompletion
    ): Promise<void> {
        const reason =
            completion.outcome === 'failed'
                ? completion.errorSummary || 'scheduled_task_failed'
                : run.reason;
        await this.repository.updateRun(run.id, {
            finishedAt: this.now(),
            outcome: completion.outcome,
            reason,
            sessionId: completion.sessionId,
            turnId: completion.turnId,
        });
        this.runningTasks.delete(task.id);
        await this.repository.pruneRuns(task.id);

        if (completion.outcome === 'failed') {
            if (!this.failedStreaks.has(task.id)) {
                this.failedStreaks.add(task.id);
                try {
                    this.host.notifyFailure?.({
                        scheduleId: task.id,
                        scheduleName: task.name,
                        reason: reason || 'scheduled_task_failed',
                    });
                } catch (error) {
                    this.host.diagnostics.warn(
                        `[TaskScheduler] Failed to notify schedule failure ${task.id}: ${compactError(error)}`
                    );
                }
            }
        } else {
            this.failedStreaks.delete(task.id);
        }
    }

    private async recordEvidence(
        task: ScheduledTask,
        scheduledFor: number,
        outcome: Extract<ScheduledTaskRunOutcome, 'missed' | 'skipped_overlap'>,
        reason: string
    ): Promise<void> {
        const now = this.now();
        const inserted = await this.repository.insertRun({
            id: this.createId(),
            scheduleId: task.id,
            scheduleVersion: task.version,
            scheduledFor,
            startedAt: null,
            finishedAt: now,
            outcome,
            reason,
            backgroundTaskId: null,
            sessionId: null,
            turnId: null,
            createdAt: now,
        });
        if (inserted) await this.repository.pruneRuns(task.id);
    }

    private async recordDstGaps(task: ScheduledTask, now: number): Promise<void> {
        if (task.trigger.type !== 'cron' || task.deletedAt !== null) return;
        // A paused or edited version starts at updatedAt. Looking back before it
        // could attribute a DST gap that occurred while the schedule was inactive.
        const from = Math.max(task.lastRunAt ?? task.createdAt, task.updatedAt);
        const skipped = findSkippedDstOccurrences({
            trigger: task.trigger,
            timezone: task.timezone,
            from,
            until: now,
        });
        for (const scheduledFor of skipped) {
            const inserted = await this.repository.insertRun({
                id: this.createId(),
                scheduleId: task.id,
                scheduleVersion: task.version,
                scheduledFor,
                startedAt: null,
                finishedAt: now,
                outcome: 'skipped_dst',
                reason: 'nonexistent_local_time',
                backgroundTaskId: null,
                sessionId: null,
                turnId: null,
                createdAt: now,
            });
            if (inserted) await this.repository.pruneRuns(task.id);
        }
    }

    private async advanceTask(
        task: ScheduledTask,
        scheduledFor: number,
        now: number
    ): Promise<void> {
        if (task.trigger.type === 'once') {
            task.enabled = false;
            task.nextRunAt = null;
        } else {
            task.nextRunAt = this.calculateNextAfter(task, scheduledFor, now);
        }
        task.updatedAt = now;
        await this.repository.updateTask(task);
    }

    private calculateNextAfter(
        task: ScheduledTask,
        scheduledFor: number,
        now: number
    ): number | null {
        if (task.trigger.type === 'cron') {
            return this.calculateNextRun(
                task.trigger,
                new Date(Math.max(scheduledFor, now)),
                task.timezone
            );
        }
        if (task.trigger.type === 'interval') {
            return now + task.trigger.milliseconds;
        }
        return null;
    }

    private async disableOneTimeTask(task: ScheduledTask): Promise<void> {
        task.enabled = false;
        task.nextRunAt = null;
        task.updatedAt = this.now();
        await this.repository.updateTask(task);
        this.clearTaskResources(task.id);
    }

    private serializeTaskMutation<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.taskMutations.get(taskId) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        this.taskMutations.set(taskId, current);
        const cleanup = () => {
            if (this.taskMutations.get(taskId) === current) {
                this.taskMutations.delete(taskId);
            }
        };
        void current.then(cleanup, cleanup);
        return current;
    }

    private attachResource(taskId: string, version: number, cleanup: () => void): void {
        const binding = this.scheduleBindings.get(taskId);
        if (
            !binding ||
            binding.version !== version ||
            binding.state === 'disposed' ||
            !this.isCurrentVersion(taskId, version)
        ) {
            cleanup();
            return;
        }
        const previousCleanup = binding.cleanup;
        binding.cleanup = cleanup;
        binding.state = 'armed';
        previousCleanup?.();
    }

    private clearTaskResources(taskId: string): void {
        const binding = this.scheduleBindings.get(taskId);
        if (!binding) return;
        this.scheduleBindings.delete(taskId);
        binding.state = 'disposed';
        const cleanup = binding.cleanup;
        binding.cleanup = null;
        cleanup?.();
    }

    private isCurrentVersion(taskId: string, version: number): boolean {
        return !this.disposed && this.tasks.get(taskId)?.version === version;
    }
}
