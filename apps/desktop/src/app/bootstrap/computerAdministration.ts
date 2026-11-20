import { z } from 'zod';

import {
    COMPUTER_USE_GROUPS,
    type ComputerAdministrationApi,
    ComputerCommandError,
} from '@/app/api/tools/computer';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

const REQUEST_EVENT = 'tools:computer:administration:request';
const REPLY_EVENT = 'tools:computer:administration:reply';
const driver = z.enum(['cua-driver', 'agent-desktop']);
const group = z.enum(COMPUTER_USE_GROUPS);
const settingsSchema = z.strictObject({
    allowForeground: z.boolean(),
    allowedApps: z.array(z.string()),
    approval: z.enum(['each', 'session-window', 'full-access']),
    cursorVisible: z.boolean(),
    enabled: z.boolean(),
    maxImageDimension: z.number().positive(),
    recordingEnabled: z.boolean(),
    telemetryEnabled: z.boolean(),
});
const groupsSchema = z.partialRecord(group, z.boolean());
const statusSchema = z.strictObject({
    abiVersion: z.string().nullable(),
    binary: z.string().nullable(),
    driverVersion: z.string().nullable(),
    installedSizeBytes: z.number().nullable().optional(),
    error: z.string().nullable(),
    installed: z.boolean(),
});
const updateSchema = z.strictObject({
    current: z.string(),
    error: z.string().nullable(),
    latest: z.string().nullable(),
    updateAvailable: z.boolean(),
});
const commands = z.discriminatedUnion('operation', [
    z.strictObject({
        operation: z.enum([
            'isEnabled',
            'loadGroups',
            'loadDriver',
            'loadDriverDirectory',
            'loadSettings',
            'applySettings',
            'loadRecordingDirectory',
        ]),
    }),
    z.strictObject({ operation: z.literal('setEnabled'), enabled: z.boolean() }),
    z.strictObject({ operation: z.literal('setGroupEnabled'), group, enabled: z.boolean() }),
    z.strictObject({ operation: z.literal('selectDriver'), driver }),
    z.strictObject({ operation: z.literal('saveDriverDirectory'), directory: z.string() }),
    z.strictObject({ operation: z.literal('saveRecordingDirectory'), directory: z.string() }),
    z.strictObject({ operation: z.literal('saveSettings'), patch: settingsSchema.partial() }),
    z.strictObject({
        operation: z.enum(['status', 'prepare', 'checkUpdate', 'remove']),
        driver: driver.optional(),
    }),
    z.strictObject({ operation: z.literal('installUpdate'), driver, version: z.string().min(1) }),
    z.strictObject({ operation: z.literal('setRecording'), enabled: z.boolean() }),
    z.strictObject({ operation: z.literal('setRecordingEnabled'), enabled: z.boolean() }),
]);
type Command = z.infer<typeof commands>;
const requestSchema = z.strictObject({
    requestId: z.uuid(),
    from: z.literal('settings'),
    command: commands,
});
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({ requestId: z.uuid(), ok: z.literal(true), result: z.unknown() }),
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(false),
        code: z.enum([
            'COMPUTER_COMMAND_UNAVAILABLE',
            'COMPUTER_COMMAND_UNCONFIRMED',
            'COMPUTER_COMMAND_FAILED',
        ]),
        outcome: z.enum(['none', 'unknown']),
    }),
]);
type Reply = z.infer<typeof replySchema>;
function deadline(command: Command): number {
    return ['prepare', 'installUpdate', 'saveDriverDirectory', 'remove'].includes(command.operation)
        ? 300_000
        : 5_000;
}

/** Main's existing computer-control instance; no arbitrary execution over this channel. */
export function createComputerAdministrationWindow(input: {
    label: string | null;
    signal: AbortSignal;
    owner?(signal: AbortSignal): Promise<ComputerAdministrationApi>;
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
    function warn() {
        try {
            input.warn('COMPUTER_COMMAND_FAILED');
        } catch {
            /* Passive diagnostics. */
        }
    }
    const failure = (requestId: string, error: ComputerCommandError): Reply => ({
        requestId,
        ok: false,
        code: error.code,
        outcome: error.outcome,
    });

    async function run(command: Command): Promise<unknown> {
        if (disposed || !input.owner || running >= 16)
            throw new ComputerCommandError('COMPUTER_COMMAND_UNAVAILABLE', 'none');
        running++;
        const timeout = new AbortController();
        const timer = setTimeout(
            () =>
                timeout.abort(new ComputerCommandError('COMPUTER_COMMAND_UNCONFIRMED', 'unknown')),
            deadline(command)
        );
        const combined = combineAbortSignals([input.signal, timeout.signal]);
        try {
            return await awaitAbortable(async () => {
                const owner = await input.owner!(combined.signal);
                combined.signal.throwIfAborted();
                switch (command.operation) {
                    case 'isEnabled':
                        return owner.isEnabled();
                    case 'loadGroups':
                        return owner.loadGroups();
                    case 'loadDriver':
                        return owner.loadDriver();
                    case 'loadDriverDirectory':
                        return owner.loadDriverDirectory();
                    case 'loadSettings':
                        return owner.loadSettings();
                    case 'applySettings':
                        return owner.applySettings();
                    case 'loadRecordingDirectory':
                        return owner.loadRecordingDirectory();
                    case 'setEnabled':
                        return owner.setEnabled(command.enabled).then(() => null);
                    case 'setGroupEnabled':
                        return owner
                            .setGroupEnabled(command.group, command.enabled)
                            .then(() => null);
                    case 'selectDriver':
                        return owner.selectDriver(command.driver).then(() => null);
                    case 'saveDriverDirectory':
                        return owner.saveDriverDirectory(command.directory);
                    case 'saveRecordingDirectory':
                        return owner.saveRecordingDirectory(command.directory);
                    case 'saveSettings':
                        return owner.saveSettings(command.patch);
                    case 'status':
                        return owner.status(command.driver);
                    case 'prepare':
                        return owner.prepare(command.driver);
                    case 'checkUpdate':
                        return owner.checkUpdate(command.driver);
                    case 'remove':
                        return owner.remove(command.driver).then(() => null);
                    case 'installUpdate':
                        return owner.installUpdate(command.driver, command.version);
                    case 'setRecording':
                        return owner.setRecording(command.enabled).then(() => null);
                    case 'setRecordingEnabled':
                        return owner.setRecordingEnabled(command.enabled);
                    default:
                        throw new ComputerCommandError('COMPUTER_COMMAND_UNAVAILABLE', 'none');
                }
            }, combined.signal);
        } catch (error) {
            if (error instanceof ComputerCommandError) throw error;
            throw new ComputerCommandError('COMPUTER_COMMAND_FAILED', 'unknown');
        } finally {
            combined.dispose();
            clearTimeout(timer);
            running--;
        }
    }

    async function serve(payload: unknown) {
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success || disposed) return;
        const request = parsed.data;
        const now = Date.now();
        for (const [id, entry] of served)
            if (entry.completedAt !== undefined && now - entry.completedAt >= 300_000)
                served.delete(id);
        const command = JSON.stringify(request.command);
        let entry = served.get(request.requestId);
        if (entry && entry.command !== command) return;
        if (!entry) {
            if (served.size >= 64) {
                for (const [id, value] of served)
                    if (value.completedAt !== undefined) {
                        served.delete(id);
                        break;
                    }
            }
            if (served.size >= 64) {
                await emitWindowEvent(
                    request.from,
                    REPLY_EVENT,
                    failure(
                        request.requestId,
                        new ComputerCommandError('COMPUTER_COMMAND_UNAVAILABLE', 'none')
                    )
                ).catch(warn);
                return;
            }
            entry = {
                command,
                completion: run(request.command).then(
                    (result): Reply => ({ requestId: request.requestId, ok: true, result }),
                    (error: ComputerCommandError) => failure(request.requestId, error)
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

    async function request(command: Command): Promise<unknown> {
        if (disposed || !supported || !commands.safeParse(command).success || pending.size >= 16) {
            throw new ComputerCommandError('COMPUTER_COMMAND_UNAVAILABLE', 'none');
        }
        if (input.label === 'main') return run(command);
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const finish = (reply: Reply) => {
                if (!pending.delete(requestId)) return;
                clearTimeout(timer);
                if (reply.ok) resolve(reply.result);
                else reject(new ComputerCommandError(reply.code, reply.outcome));
            };
            const timer = setTimeout(
                () =>
                    finish(
                        failure(
                            requestId,
                            new ComputerCommandError('COMPUTER_COMMAND_UNCONFIRMED', 'unknown')
                        )
                    ),
                deadline(command)
            );
            pending.set(requestId, finish);
            void ready
                .then(async () => {
                    if (pending.has(requestId))
                        await emitWindowEvent('main', REQUEST_EVENT, {
                            requestId,
                            from: 'settings',
                            command,
                        });
                })
                .catch(() =>
                    finish(
                        failure(
                            requestId,
                            new ComputerCommandError('COMPUTER_COMMAND_UNAVAILABLE', 'none')
                        )
                    )
                );
        });
    }
    const api = Object.freeze<ComputerAdministrationApi>({
        isEnabled: async () => z.boolean().parse(await request({ operation: 'isEnabled' })),
        setEnabled: async (enabled) => {
            await request({ operation: 'setEnabled', enabled });
        },
        loadGroups: async () => groupsSchema.parse(await request({ operation: 'loadGroups' })),
        setGroupEnabled: async (group, enabled) => {
            await request({ operation: 'setGroupEnabled', group, enabled });
        },
        loadDriver: async () => driver.parse(await request({ operation: 'loadDriver' })),
        selectDriver: async (driver) => {
            await request({ operation: 'selectDriver', driver });
        },
        loadDriverDirectory: async () =>
            z.string().parse(await request({ operation: 'loadDriverDirectory' })),
        saveDriverDirectory: async (directory) =>
            z.string().parse(await request({ operation: 'saveDriverDirectory', directory })),
        loadSettings: async () =>
            settingsSchema.parse(await request({ operation: 'loadSettings' })),
        saveSettings: async (patch) =>
            settingsSchema.parse(await request({ operation: 'saveSettings', patch })),
        status: async (driver) =>
            statusSchema.parse(await request({ operation: 'status', driver })),
        prepare: async (driver) =>
            statusSchema.parse(await request({ operation: 'prepare', driver })),
        checkUpdate: async (driver) =>
            updateSchema.parse(await request({ operation: 'checkUpdate', driver })),
        installUpdate: async (driver, version) =>
            statusSchema.parse(await request({ operation: 'installUpdate', driver, version })),
        remove: async (driver) => {
            await request({ operation: 'remove', driver });
        },
        applySettings: async () =>
            z.array(z.string()).parse(await request({ operation: 'applySettings' })),
        setRecording: async (enabled) => {
            await request({ operation: 'setRecording', enabled });
        },
        setRecordingEnabled: async (enabled) =>
            settingsSchema.parse(await request({ operation: 'setRecordingEnabled', enabled })),
        loadRecordingDirectory: async () =>
            z.string().parse(await request({ operation: 'loadRecordingDirectory' })),
        saveRecordingDirectory: async (directory) =>
            z.string().parse(await request({ operation: 'saveRecordingDirectory', directory })),
    });
    function dispose() {
        if (disposed) return;
        disposed = true;
        stop?.();
        stop = undefined;
        for (const [id, finish] of [...pending])
            finish(
                failure(id, new ComputerCommandError('COMPUTER_COMMAND_UNCONFIRMED', 'unknown'))
            );
        served.clear();
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, ready, dispose });
}
