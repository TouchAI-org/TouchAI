import type { ModelInfo } from '@touchai/models/contracts';
import { z } from 'zod';

import { AiError, AiErrorCode } from '@/app/api/agent/errors';
import type { ModelDiscoveryApi } from '@/app/api/models/discovery';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

const REQUEST_EVENT = 'models:discovery:request';
const REPLY_EVENT = 'models:discovery:reply';
const TIMEOUT_MS = 60_000;
const MAX_PENDING = 16;
const requestFields = { requestId: z.uuid(), replyTo: z.literal('settings') };
const requestSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('list'),
        ...requestFields,
        providerId: z.number().int().positive(),
    }),
    z.strictObject({ kind: z.literal('cancel'), ...requestFields }),
]);
const reasoningOption = z.discriminatedUnion('type', [
    z.object({ type: z.literal('effort'), values: z.array(z.string()) }),
    z.object({ type: z.literal('toggle') }),
    z.object({
        type: z.literal('budget_tokens'),
        min: z.number().optional(),
        max: z.number().optional(),
    }),
]);
// Project the neutral discovery contract, never arbitrary upstream fields or profile data.
const modelsSchema = z.array(
    z.object({
        id: z.string(),
        name: z.string(),
        capabilities: z
            .object({
                contextLimit: z.number().optional(),
                outputLimit: z.number().optional(),
                modalities: z
                    .object({ input: z.array(z.string()), output: z.array(z.string()) })
                    .optional(),
                attachment: z.boolean().optional(),
                reasoning: z.boolean().optional(),
                reasoningOptions: z.array(reasoningOption).optional(),
                toolCall: z.boolean().optional(),
            })
            .optional(),
    })
);
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({ requestId: z.uuid(), ok: z.literal(true), models: modelsSchema }),
    z.strictObject({ requestId: z.uuid(), ok: z.literal(false), code: z.enum(AiErrorCode) }),
]);

function safeError(error: unknown): AiError {
    if (error && typeof error === 'object' && 'code' in error) {
        if (Object.values(AiErrorCode).includes(error.code as AiErrorCode))
            return new AiError(error.code as AiErrorCode);
        if (error.code === 'PROVIDER_BINDING_REVOKED')
            return new AiError(AiErrorCode.INVALID_CONFIG);
    }
    const status = error instanceof Error ? /^HTTP (\d{3})\b/.exec(error.message)?.[1] : undefined;
    const codes: Record<string, AiErrorCode> = {
        '401': AiErrorCode.UNAUTHORIZED,
        '403': AiErrorCode.UNAUTHORIZED,
        '408': AiErrorCode.TIMEOUT,
        '429': AiErrorCode.RATE_LIMIT,
        '502': AiErrorCode.BAD_GATEWAY,
        '503': AiErrorCode.SERVICE_UNAVAILABLE,
        '504': AiErrorCode.GATEWAY_TIMEOUT,
    };
    return new AiError(
        (status && codes[status]) || AiError.fromError(error, AiErrorCode.API_ERROR).code
    );
}

/** A discovery-only query using existing directed events, not an execution RPC channel. */
export function createModelDiscoveryWindow(input: {
    label: string | null;
    signal: AbortSignal;
    discover?(providerId: number, signal: AbortSignal): Promise<ModelInfo[]>;
    warn(code: string): void;
}) {
    const owned = new Map<string, AbortController>();
    const pending = new Map<
        string,
        { finish(result: { models: ModelInfo[] } | { error: AiError }): void }
    >();
    let disposed = input.signal.aborted;
    let stop: (() => void) | undefined;
    const warn = (error: unknown) => {
        try {
            input.warn(safeError(error).code);
        } catch {
            /* Passive diagnostics. */
        }
    };
    const send = (target: string, event: string, payload: unknown) =>
        emitWindowEvent(target, event, payload);

    async function discover(
        providerId: number,
        requestId: string,
        signal?: AbortSignal
    ): Promise<ModelInfo[]> {
        if (disposed) throw new AiError(AiErrorCode.REQUEST_CANCELLED);
        if (!input.discover || owned.size >= MAX_PENDING)
            throw new AiError(AiErrorCode.SERVICE_UNAVAILABLE);
        const controller = new AbortController();
        owned.set(requestId, controller);
        const timer = setTimeout(
            () => controller.abort(new AiError(AiErrorCode.TIMEOUT)),
            TIMEOUT_MS
        );
        const combined = combineAbortSignals([input.signal, controller.signal, signal]);
        try {
            const models = await awaitAbortable(
                () => input.discover!(providerId, combined.signal),
                combined.signal
            );
            return modelsSchema.parse(models);
        } catch (error) {
            throw safeError(error);
        } finally {
            combined.dispose();
            clearTimeout(timer);
            owned.delete(requestId);
        }
    }

    async function serve(payload: unknown): Promise<void> {
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success || disposed) return;
        const message = parsed.data;
        if (message.kind === 'cancel') {
            owned.get(message.requestId)?.abort();
            return;
        }
        if (owned.has(message.requestId)) return;
        let reply: z.infer<typeof replySchema>;
        try {
            reply = {
                requestId: message.requestId,
                ok: true,
                models: await discover(message.providerId, message.requestId),
            };
        } catch (error) {
            reply = { requestId: message.requestId, ok: false, code: safeError(error).code };
        }
        if (!disposed) await send(message.replyTo, REPLY_EVENT, reply).catch(warn);
    }

    const supported = input.label === 'main' || input.label === 'settings';
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
                          reply.ok ? { models: reply.models } : { error: new AiError(reply.code) }
                      );
              }
          ).then((unlisten) => {
              if (disposed) unlisten();
              else stop = unlisten;
          })
        : Promise.resolve();
    void ready.catch(warn);

    const api = Object.freeze<ModelDiscoveryApi>({
        async listModels(providerId, options) {
            if (!Number.isSafeInteger(providerId) || providerId <= 0)
                throw new AiError(AiErrorCode.INVALID_CONFIG);
            if (disposed || options?.signal?.aborted)
                throw new AiError(AiErrorCode.REQUEST_CANCELLED);
            if (!supported) throw new AiError(AiErrorCode.SERVICE_UNAVAILABLE);
            const requestId = crypto.randomUUID();
            if (input.label === 'main') return discover(providerId, requestId, options?.signal);
            if (pending.size >= MAX_PENDING) throw new AiError(AiErrorCode.SERVICE_UNAVAILABLE);
            return new Promise<ModelInfo[]>((resolve, reject) => {
                let sent = false;
                const cancelRemote = () => {
                    if (sent)
                        void send('main', REQUEST_EVENT, {
                            kind: 'cancel',
                            requestId,
                            replyTo: 'settings',
                        }).catch(warn);
                };
                const finish = (result: { models: ModelInfo[] } | { error: AiError }) => {
                    if (!pending.delete(requestId)) return;
                    clearTimeout(timer);
                    options?.signal?.removeEventListener('abort', cancel);
                    if ('models' in result) resolve(result.models);
                    else {
                        cancelRemote();
                        reject(result.error);
                    }
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
                        if (!pending.has(requestId)) return;
                        sent = true;
                        await send('main', REQUEST_EVENT, {
                            kind: 'list',
                            requestId,
                            replyTo: 'settings',
                            providerId,
                        });
                    })
                    .catch((error) => finish({ error: safeError(error) }));
            });
        },
    });

    function dispose(): void {
        if (disposed) return;
        disposed = true;
        stop?.();
        stop = undefined;
        for (const request of [...pending.values()])
            request.finish({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) });
        for (const controller of owned.values()) controller.abort();
        owned.clear();
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, ready, dispose });
}
