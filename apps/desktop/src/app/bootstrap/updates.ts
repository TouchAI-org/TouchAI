import { z } from 'zod';

import type {
    AppUpdateChannel,
    AppUpdateState,
    UpdatePreferencesApi,
    UpdatesApi,
} from '@/app/api/updates/contracts';
import { createInitialAppUpdateState } from '@/app/api/updates/contracts';
import type { AppUpdateController } from '@/modules/updates';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { getVersion, openUrl } from '@/platform/windows/external';

const REQUEST = 'updates:request';
const REPLY = 'updates:reply';
const STATE = 'updates:state';
const TIMEOUT = 60_000;
const channel = z.enum(['stable', 'beta', 'nightly']);
const commandSchema = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('snapshot') }),
    z.strictObject({ operation: z.literal('check'), source: z.enum(['manual', 'settings-open']) }),
    z.strictObject({ operation: z.literal('download') }),
    z.strictObject({ operation: z.literal('install') }),
    z.strictObject({ operation: z.literal('channel'), channel }),
    z.strictObject({ operation: z.literal('auto-check'), enabled: z.boolean() }),
]);
type Command = z.infer<typeof commandSchema>;
const requestSchema = z.strictObject({
    requestId: z.uuid(),
    createdAt: z.number().int().nonnegative(),
    from: z.literal('settings'),
    command: commandSchema,
});
const info = z.strictObject({
    version: z.string(),
    fileName: z.string(),
    notes: z.string().nullable(),
    sizeBytes: z.number().nullable(),
});
const release = z.strictObject({
    version: z.string(),
    publishedAt: z.string().nullable(),
    releaseNotes: z.string().nullable(),
    releaseNotesByLocale: z.record(z.string(), z.string()).optional(),
});
const stateSchema = z.strictObject({
    status: z.enum([
        'idle',
        'checking',
        'available',
        'not_available',
        'unsupported',
        'downloading',
        'downloaded',
        'installing',
        'failed',
    ]),
    channel,
    autoCheckEnabled: z.boolean(),
    currentVersion: z.string().nullable(),
    availableUpdate: info.nullable(),
    downloadedUpdate: info.nullable(),
    latestUpdate: release
        .extend({
            tag: z.string(),
            releaseUrl: z.string(),
            prerelease: z.boolean(),
            releaseHistory: z.array(release).optional(),
            downloads: z.array(
                z.strictObject({
                    kind: z.string(),
                    name: z.string(),
                    url: z.string(),
                    sizeBytes: z.number().nullable(),
                })
            ),
        })
        .nullable(),
    updateRequirement: z
        .strictObject({
            required: z.boolean(),
            minimumSupportedVersion: z.string().nullable(),
            requiredSeverity: z.string().nullable(),
            requiredReason: z.string().nullable(),
            targetSatisfiesRequirement: z.boolean(),
        })
        .nullable(),
    downloadProgress: z.number().nullable(),
    lastCheckedAt: z.string().nullable(),
    error: z.string().nullable(),
    unsupportedReason: z
        .enum(['not_installed', 'platform_unsupported', 'updater_unavailable'])
        .nullable(),
});
const snapshotSchema = z.strictObject({
    ownerId: z.uuid(),
    revision: z.number().int().nonnegative(),
    state: stateSchema,
});
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(true),
        snapshot: snapshotSchema,
        result: z.boolean(),
    }),
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(false),
        code: z.enum(['UPDATES_UNAVAILABLE', 'UPDATES_UNCONFIRMED']),
    }),
]);
type Reply = z.infer<typeof replySchema>;

/** Secondary windows observe main's state and never create a controller or replay an effect. */
export function createUpdatesWindow(input: {
    label: string | null;
    signal: AbortSignal;
    owner?: AppUpdateController;
    warn(code: string): void;
}) {
    const ownerId = crypto.randomUUID();
    let revision = 0;
    let state = input.owner?.getState() ?? createInitialAppUpdateState();
    let remoteOwner: string | undefined;
    let remoteRevision = -1;
    let disposed = input.signal.aborted;
    let running = 0;
    const stops = new Set<() => void>();
    const listeners = new Set<(state: AppUpdateState) => void>();
    const pending = new Map<string, (reply: Reply) => void>();
    const served = new Map<
        string,
        { signature: string; expiresAt: number; done: boolean; completion: Promise<Reply> }
    >();
    const failure = (
        requestId: string,
        code: 'UPDATES_UNAVAILABLE' | 'UPDATES_UNCONFIRMED'
    ): Reply => ({ requestId, ok: false, code });
    const unavailable = () => new Error('UPDATES_UNAVAILABLE');
    const warn = () => {
        try {
            input.warn('UPDATES_UNCONFIRMED');
        } catch {
            /* Passive diagnostics. */
        }
    };
    const snapshot = () => ({ ownerId, revision, state: input.owner?.getState() ?? state });
    function publish() {
        for (const listener of listeners) {
            try {
                listener(structuredClone(state));
            } catch {
                warn();
            }
        }
    }
    function accept(value: z.infer<typeof snapshotSchema>, establish = false) {
        if (disposed || (!establish && remoteOwner && value.ownerId !== remoteOwner)) return;
        if (value.ownerId === remoteOwner && value.revision < remoteRevision) return;
        remoteOwner = value.ownerId;
        remoteRevision = value.revision;
        state = value.state;
        publish();
    }
    async function execute(command: Command, administration: boolean) {
        if (disposed || !input.owner) throw unavailable();
        await input.owner.initialize();
        if (disposed) throw unavailable();
        if (command.operation === 'snapshot') return true;
        if (command.operation === 'check') return input.owner.checkNow(command.source);
        if (command.operation === 'download') return input.owner.download();
        if (command.operation === 'install') return input.owner.install();
        if (!administration) throw unavailable();
        if (command.operation === 'channel') await input.owner.setChannel(command.channel);
        else await input.owner.setAutoCheckEnabled(command.enabled);
        return true;
    }
    async function serve(payload: unknown) {
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success || disposed) return;
        const request = parsed.data;
        const now = Date.now();
        if (request.createdAt > now || now - request.createdAt >= TIMEOUT) return;
        for (const [id, entry] of served)
            if (entry.done && entry.expiresAt <= now) served.delete(id);
        const signature = JSON.stringify(request);
        let entry = served.get(request.requestId);
        if (entry && entry.signature !== signature) return;
        if (!entry) {
            if (served.size >= 64 || running >= 16) {
                await emitWindowEvent(
                    'settings',
                    REPLY,
                    failure(request.requestId, 'UPDATES_UNAVAILABLE')
                ).catch(warn);
                return;
            }
            running++;
            entry = {
                signature,
                expiresAt: request.createdAt + TIMEOUT,
                done: false,
                completion: execute(request.command, true)
                    .then(
                        (result): Reply => ({
                            requestId: request.requestId,
                            ok: true,
                            result,
                            snapshot: snapshot(),
                        }),
                        (): Reply => failure(request.requestId, 'UPDATES_UNCONFIRMED')
                    )
                    .finally(() => {
                        running--;
                        const current = served.get(request.requestId);
                        if (current) current.done = true;
                    }),
            };
            served.set(request.requestId, entry);
        }
        const reply = await entry.completion;
        if (!disposed) await emitWindowEvent('settings', REPLY, reply).catch(warn);
    }
    async function register(event: string, listener: (payload: unknown) => void) {
        const stop = await listenWindowEvent(input.label!, event, listener);
        if (disposed) stop();
        else stops.add(stop);
    }
    const ready =
        input.label === 'main'
            ? register(REQUEST, (payload) => {
                  void serve(payload).catch(warn);
              })
            : input.label === 'settings'
              ? Promise.all([
                    register(REPLY, (payload) => {
                        const parsed = replySchema.safeParse(payload);
                        if (parsed.success) pending.get(parsed.data.requestId)?.(parsed.data);
                    }),
                    register(STATE, (payload) => {
                        const parsed = snapshotSchema.safeParse(payload);
                        if (parsed.success) accept(parsed.data);
                    }),
                ]).then(() => undefined)
              : Promise.resolve();
    void ready.catch(warn);
    if (input.label === 'main' && input.owner)
        stops.add(
            input.owner.subscribe((next) => {
                if (disposed) return;
                state = next;
                revision++;
                publish();
                void emitWindowEvent('settings', STATE, snapshot()).catch(warn);
            })
        );
    async function request(command: Command): Promise<boolean> {
        if (disposed || !commandSchema.safeParse(command).success) throw unavailable();
        if (input.label === 'main') return execute(command, false);
        if (input.label !== 'settings' || pending.size >= 16) throw unavailable();
        const requestId = crypto.randomUUID();
        const createdAt = Date.now();
        return new Promise<boolean>((resolve, reject) => {
            const finish = (reply: Reply) => {
                if (!pending.delete(requestId)) return;
                clearTimeout(timer);
                if (reply.ok) {
                    accept(reply.snapshot, command.operation === 'snapshot');
                    resolve(reply.result);
                } else reject(new Error(reply.code));
            };
            const timer = setTimeout(
                () => finish(failure(requestId, 'UPDATES_UNCONFIRMED')),
                TIMEOUT
            );
            pending.set(requestId, finish);
            void ready
                .then(async () => {
                    if (pending.has(requestId))
                        await emitWindowEvent('main', REQUEST, {
                            requestId,
                            createdAt,
                            from: 'settings',
                            command,
                        });
                })
                .catch(() => finish(failure(requestId, 'UPDATES_UNAVAILABLE')));
        });
    }
    const api = Object.freeze<UpdatesApi>({
        getState: () => structuredClone(state),
        subscribe(listener) {
            listeners.add(listener);
            listener(structuredClone(state));
            return () => {
                listeners.delete(listener);
            };
        },
        async initialize() {
            if (input.label === 'main' || input.label === 'settings')
                await request({ operation: 'snapshot' });
        },
        checkNow: (source = 'manual') =>
            input.label === 'main' && source === 'automatic' && !disposed && input.owner
                ? input.owner.checkNow(source)
                : request({ operation: 'check', source: source as 'manual' | 'settings-open' }),
        download: () => request({ operation: 'download' }),
        install: () => request({ operation: 'install' }),
        async getVersion() {
            if (disposed || !['main', 'settings'].includes(input.label ?? '')) throw unavailable();
            return getVersion();
        },
        async openDownload(url) {
            if (disposed || !['main', 'settings'].includes(input.label ?? '')) throw unavailable();
            await openUrl(url);
        },
    });
    const preferences: UpdatePreferencesApi | undefined =
        input.label === 'settings'
            ? Object.freeze({
                  async setChannel(channel: AppUpdateChannel) {
                      await request({ operation: 'channel', channel });
                  },
                  async setAutoCheckEnabled(enabled: boolean) {
                      await request({ operation: 'auto-check', enabled });
                  },
              })
            : undefined;
    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const stop of stops) stop();
        stops.clear();
        listeners.clear();
        for (const [id, finish] of [...pending]) finish(failure(id, 'UPDATES_UNCONFIRMED'));
        served.clear();
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, preferences, ready, dispose });
}
