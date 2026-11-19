import { z } from 'zod';

import type {
    DataManagementApi,
    DataManagementHost,
} from '@/app/workflows/data-management/contracts';
import {
    DataManagementError,
    dataManagementErrorCodes,
} from '@/app/workflows/data-management/contracts';
import { t } from '@/i18n';
import { open, save } from '@/platform/files/dialogs';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { relaunch } from '@/platform/windows/process';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

const REQUEST = 'data-management:request';
const REPLY = 'data-management:reply';
const TIMEOUT = 60_000;
const path = z.string().min(1).max(32_768);
const commandSchema = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('stats') }),
    z.strictObject({
        operation: z.literal('clear'),
        category: z.enum(['sessions', 'messages', 'sessionTurns']),
    }),
    z.strictObject({ operation: z.literal('export'), targetPath: path }),
    z.strictObject({
        operation: z.literal('import'),
        sourcePath: path,
        mode: z.enum(['full', 'chat_only']),
    }),
]);
type Command = z.infer<typeof commandSchema>;
const requestSchema = z.strictObject({
    requestId: z.uuid(),
    createdAt: z.number().int().nonnegative(),
    from: z.literal('settings'),
    command: commandSchema,
});
const statsSchema = z.strictObject({
    sessions: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    sessionTurns: z.number().int().nonnegative(),
});
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({ requestId: z.uuid(), ok: z.literal(true), result: statsSchema.nullable() }),
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(false),
        code: z.enum(dataManagementErrorCodes),
    }),
]);
type Reply = z.infer<typeof replySchema>;

/** Directed settings commands; an unknown effect is never automatically retried. */
export function createDataManagementWindow(input: {
    label: string | null;
    signal: AbortSignal;
    owner?(signal: AbortSignal): Promise<DataManagementHost>;
    warn(code: string): void;
}) {
    let disposed = input.signal.aborted;
    let stop: (() => void) | undefined;
    let running = 0;
    const pending = new Map<string, (reply: Reply) => void>();
    const served = new Map<
        string,
        { command: string; completion: Promise<Reply>; expiresAt: number }
    >();
    const unavailable = () => new DataManagementError('DATA_MANAGEMENT_UNAVAILABLE');
    const unconfirmed = () => new DataManagementError('DATA_MANAGEMENT_UNCONFIRMED');
    const failed = (requestId: string, error: DataManagementError): Reply => ({
        requestId,
        ok: false,
        code: error.code,
    });
    const warn = () => {
        try {
            input.warn('DATA_MANAGEMENT_UNCONFIRMED');
        } catch {
            /* Passive diagnostics. */
        }
    };
    async function run(command: Command, expiresAt: number) {
        if (disposed || !input.owner || running >= 16) throw unavailable();
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(unconfirmed()),
            Math.max(0, expiresAt - Date.now())
        );
        const combined = combineAbortSignals([input.signal, deadline.signal]);
        running++;
        try {
            return await awaitAbortable(async () => {
                const owner = await input.owner!(combined.signal);
                combined.signal.throwIfAborted();
                if (command.operation === 'stats') return statsSchema.parse(await owner.stats());
                if (command.operation === 'clear') await owner.clear(command.category);
                else if (command.operation === 'export')
                    await owner.exportBackup(command.targetPath);
                else await owner.importBackup(command.sourcePath, command.mode);
                return null;
            }, combined.signal);
        } catch (error) {
            if (error instanceof DataManagementError) throw error;
            throw unconfirmed();
        } finally {
            running--;
            combined.dispose();
            clearTimeout(timer);
        }
    }
    async function serve(payload: unknown) {
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success || disposed) return;
        const request = parsed.data;
        const now = Date.now();
        if (request.createdAt > now || now - request.createdAt >= TIMEOUT) return;
        for (const [id, entry] of served) if (entry.expiresAt <= now) served.delete(id);
        const command = JSON.stringify(request.command);
        let entry = served.get(request.requestId);
        if (entry && entry.command !== command) return;
        if (!entry) {
            if (served.size >= 64) {
                await emitWindowEvent(
                    'settings',
                    REPLY,
                    failed(request.requestId, unavailable())
                ).catch(warn);
                return;
            }
            entry = {
                command,
                expiresAt: request.createdAt + TIMEOUT,
                completion: run(request.command, request.createdAt + TIMEOUT).then(
                    (result): Reply => ({ requestId: request.requestId, ok: true, result }),
                    (error: DataManagementError) => failed(request.requestId, error)
                ),
            };
            served.set(request.requestId, entry);
        }
        const reply = await entry.completion;
        if (!disposed) await emitWindowEvent('settings', REPLY, reply).catch(warn);
    }
    const supported = input.label === 'main' || input.label === 'settings';
    const ready = supported
        ? listenWindowEvent(input.label!, input.label === 'main' ? REQUEST : REPLY, (payload) => {
              if (input.label === 'main') {
                  void serve(payload).catch(warn);
                  return;
              }
              const parsed = replySchema.safeParse(payload);
              if (parsed.success) pending.get(parsed.data.requestId)?.(parsed.data);
          }).then((unlisten) => {
              if (disposed) unlisten();
              else stop = unlisten;
          })
        : Promise.resolve();
    void ready.catch(warn);
    function requireSettings() {
        if (disposed || input.label !== 'settings') throw unavailable();
    }
    async function request(command: Command) {
        requireSettings();
        if (!commandSchema.safeParse(command).success || pending.size >= 16) throw unavailable();
        const requestId = crypto.randomUUID();
        const createdAt = Date.now();
        return new Promise<z.infer<typeof statsSchema> | null>((resolve, reject) => {
            const finish = (reply: Reply) => {
                if (!pending.delete(requestId)) return;
                clearTimeout(timer);
                if (reply.ok) resolve(reply.result);
                else reject(new DataManagementError(reply.code));
            };
            const timer = setTimeout(() => finish(failed(requestId, unconfirmed())), TIMEOUT);
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
                .catch(() => finish(failed(requestId, unavailable())));
        });
    }
    const api = Object.freeze<DataManagementApi>({
        stats: async () => statsSchema.parse(await request({ operation: 'stats' })),
        async clear(category) {
            await request({ operation: 'clear', category });
        },
        async exportDatabase(onProgress) {
            requireSettings();
            const targetPath = await save({
                defaultPath: `touchai-backup-${Math.floor(Date.now() / 1000)}.db`,
                filters: [{ name: t('database.backup.dialog.filterName'), extensions: ['db'] }],
                title: t('database.backup.dialog.exportTitle'),
            });
            requireSettings();
            if (!targetPath) throw new DataManagementError('DATABASE_BACKUP_CANCELLED');
            onProgress?.(t('database.backup.exporting'), 30);
            await request({ operation: 'export', targetPath });
            if (!disposed) onProgress?.(t('database.backup.exportComplete'), 100);
            return targetPath;
        },
        async importDatabase(mode, onProgress) {
            requireSettings();
            if (mode !== 'full' && mode !== 'chat_only') throw unavailable();
            const sourcePath = await open({
                filters: [{ name: t('database.backup.dialog.filterName'), extensions: ['db'] }],
                title: t('database.backup.dialog.importTitle'),
                multiple: false,
                directory: false,
            });
            requireSettings();
            if (!sourcePath) return false;
            if (typeof sourcePath !== 'string') throw unavailable();
            onProgress?.(t('database.backup.importing'), 30);
            await request({ operation: 'import', sourcePath, mode });
            if (!disposed) onProgress?.(t('database.backup.importComplete'), 100);
            return true;
        },
        async relaunch() {
            requireSettings();
            await relaunch();
        },
    });
    function dispose() {
        if (disposed) return;
        disposed = true;
        stop?.();
        stop = undefined;
        for (const [id, finish] of [...pending]) finish(failed(id, unconfirmed()));
        served.clear();
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, ready, dispose });
}
