import { z } from 'zod';

import { AiError, AiErrorCode } from '@/app/api/agent/errors';
import type { ModelMetadataApi } from '@/app/api/models/metadata';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

const REQUEST_EVENT = 'models:metadata:request';
const REPLY_EVENT = 'models:metadata:reply';
const TIMEOUT_MS = 60_000;
const commandSchema = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('refresh'), force: z.boolean() }),
    z.strictObject({ operation: z.literal('missing') }),
    z.strictObject({ operation: z.literal('updated-at') }),
]);
type Command = z.infer<typeof commandSchema>;
const requestSchema = z.strictObject({
    requestId: z.uuid(),
    replyTo: z.literal('settings'),
    command: commandSchema,
});
const refreshResultSchema = z.strictObject({
    status: z.enum(['updated', 'unchanged', 'skipped', 'failed']),
    reason: z.literal('fresh').optional(),
});
const resultSchema = z.union([refreshResultSchema, z.boolean(), z.string().nullable()]);
type Result = z.infer<typeof resultSchema>;
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(true),
        result: resultSchema,
    }),
    z.strictObject({ requestId: z.uuid(), ok: z.literal(false), code: z.enum(AiErrorCode) }),
]);

/** A metadata-only client channel; refresh lifetime stays with main's Models owner. */
export function createModelMetadataWindow(input: {
    label: string | null;
    signal: AbortSignal;
    owner?(signal: AbortSignal): Promise<ModelMetadataApi>;
    warn(code: string): void;
}) {
    const pending = new Map<
        string,
        { finish(result: { value: Result } | { error: AiError }): void }
    >();
    const supported = input.label === 'main' || input.label === 'settings';
    let disposed = input.signal.aborted;
    let stop: (() => void) | undefined;
    let running = 0;
    const warn = () => {
        try {
            input.warn(AiErrorCode.API_ERROR);
        } catch {
            /* Passive diagnostics. */
        }
    };
    function safeError(error: unknown): AiError {
        if (error instanceof AiError) return new AiError(error.code);
        const code =
            error instanceof Error && error.name === 'TimeoutError'
                ? AiErrorCode.TIMEOUT
                : error instanceof Error && error.name === 'AbortError'
                  ? AiErrorCode.REQUEST_CANCELLED
                  : AiErrorCode.API_ERROR;
        return new AiError(code);
    }
    async function run(command: Command, signal?: AbortSignal): Promise<Result> {
        if (disposed) throw new AiError(AiErrorCode.REQUEST_CANCELLED);
        if (!input.owner || running >= 16) throw new AiError(AiErrorCode.SERVICE_UNAVAILABLE);
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(new DOMException('Metadata query timed out', 'TimeoutError')),
            TIMEOUT_MS
        );
        const combined = combineAbortSignals([input.signal, deadline.signal, signal]);
        running++;
        try {
            return resultSchema.parse(
                await awaitAbortable(async () => {
                    const owner = await input.owner!(combined.signal);
                    combined.signal.throwIfAborted();
                    if (command.operation === 'refresh')
                        return owner.refresh({ force: command.force, signal: combined.signal });
                    if (command.operation === 'missing')
                        return owner.isMissing({ signal: combined.signal });
                    return owner.readLastUpdatedAt({ signal: combined.signal });
                }, combined.signal)
            );
        } catch (error) {
            throw safeError(error);
        } finally {
            combined.dispose();
            running--;
            clearTimeout(timer);
        }
    }
    async function serve(payload: unknown): Promise<void> {
        const request = requestSchema.safeParse(payload);
        if (!request.success || disposed) return;
        let reply: z.infer<typeof replySchema>;
        try {
            const result = await run(request.data.command);
            reply = replySchema.parse({ requestId: request.data.requestId, ok: true, result });
        } catch (error) {
            reply = { requestId: request.data.requestId, ok: false, code: safeError(error).code };
        }
        if (!disposed) await emitWindowEvent('settings', REPLY_EVENT, reply).catch(warn);
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
                  if (!parsed.success) return;
                  const reply = parsed.data;
                  pending
                      .get(reply.requestId)
                      ?.finish(
                          reply.ok ? { value: reply.result } : { error: new AiError(reply.code) }
                      );
              }
          ).then((unlisten) => {
              if (disposed) unlisten();
              else stop = unlisten;
          })
        : Promise.resolve();
    void ready.catch(warn);

    async function request(command: Command, options?: { signal?: AbortSignal }): Promise<Result> {
        if (disposed || options?.signal?.aborted) throw new AiError(AiErrorCode.REQUEST_CANCELLED);
        if (!supported) throw new AiError(AiErrorCode.SERVICE_UNAVAILABLE);
        if (input.label === 'main') return run(command, options?.signal);
        if (pending.size >= 16) throw new AiError(AiErrorCode.SERVICE_UNAVAILABLE);
        const requestId = crypto.randomUUID();
        return new Promise<Result>((resolve, reject) => {
            const finish = (result: { value: Result } | { error: AiError }) => {
                if (!pending.delete(requestId)) return;
                clearTimeout(timer);
                options?.signal?.removeEventListener('abort', cancel);
                if ('value' in result) resolve(result.value);
                else reject(result.error);
            };
            const cancel = () => finish({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) });
            const timer = setTimeout(
                () => finish({ error: new AiError(AiErrorCode.TIMEOUT) }),
                TIMEOUT_MS
            );
            pending.set(requestId, { finish });
            options?.signal?.addEventListener('abort', cancel, { once: true });
            void ready
                .then(async () => {
                    if (pending.has(requestId))
                        await emitWindowEvent('main', REQUEST_EVENT, {
                            requestId,
                            replyTo: 'settings',
                            command,
                        });
                })
                .catch(() => finish({ error: new AiError(AiErrorCode.SERVICE_UNAVAILABLE) }));
        });
    }
    const api = Object.freeze<ModelMetadataApi>({
        refresh: async (options) =>
            refreshResultSchema.parse(
                await request({ operation: 'refresh', force: options?.force ?? false }, options)
            ),
        isMissing: async (options) =>
            z.boolean().parse(await request({ operation: 'missing' }, options)),
        readLastUpdatedAt: async (options) =>
            z
                .string()
                .nullable()
                .parse(await request({ operation: 'updated-at' }, options)),
    });
    function dispose(): void {
        if (disposed) return;
        disposed = true;
        stop?.();
        stop = undefined;
        for (const request of [...pending.values()])
            request.finish({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) });
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, ready, dispose });
}
