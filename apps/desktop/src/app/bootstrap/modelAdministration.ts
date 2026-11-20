import { z } from 'zod';

import type { ModelAdministration } from '@/modules/models/public';
import {
    ModelAdministrationError,
    modelAdministrationErrorCodes,
    modelDraftSchema,
    modelPatchSchema,
    modelSchema,
    modelWithProviderSchema,
    providerDraftSchema,
    providerPatchSchema,
    providerSchema,
} from '@/modules/models/public';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

const REQUEST_EVENT = 'models:administration:request';
const REPLY_EVENT = 'models:administration:reply';
const TIMEOUT_MS = 5_000;
const LIMIT = 16;
const id = z.number().int().positive();
const discoveryModels = z.array(
    z.object({
        id: z.string(),
        name: z.string(),
        capabilities: z
            .object({
                contextLimit: z.number().optional(),
                outputLimit: z.number().optional(),
                attachment: z.boolean().optional(),
                reasoning: z.boolean().optional(),
                toolCall: z.boolean().optional(),
                modalities: z
                    .object({ input: z.array(z.string()), output: z.array(z.string()) })
                    .optional(),
                reasoningOptions: z
                    .array(
                        z.discriminatedUnion('type', [
                            z.object({ type: z.literal('toggle') }),
                            z.object({ type: z.literal('effort'), values: z.array(z.string()) }),
                            z.object({
                                type: z.literal('budget_tokens'),
                                min: z.number().optional(),
                                max: z.number().optional(),
                            }),
                        ])
                    )
                    .optional(),
            })
            .optional(),
    })
);
const commands = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('providers') }),
    z.strictObject({ operation: z.literal('provider'), id }),
    z.strictObject({ operation: z.literal('provider-create'), data: providerDraftSchema }),
    z.strictObject({ operation: z.literal('provider-update'), id, patch: providerPatchSchema }),
    z.strictObject({ operation: z.literal('provider-delete'), id }),
    z.strictObject({ operation: z.literal('default') }),
    z.strictObject({ operation: z.literal('models'), providerId: id.optional() }),
    z.strictObject({ operation: z.literal('model-create'), data: modelDraftSchema }),
    z.strictObject({ operation: z.literal('model-update'), id, patch: modelPatchSchema }),
    z.strictObject({ operation: z.literal('model-delete'), id }),
    z.strictObject({ operation: z.literal('set-default'), id }),
    z.strictObject({
        operation: z.literal('refresh-save'),
        providerId: id,
        models: discoveryModels,
    }),
]);
type Command = z.infer<typeof commands>;
const requestSchema = z.strictObject({
    requestId: z.uuid(),
    from: z.literal('settings'),
    command: commands,
});
const resultSchema = z.union([
    z.array(providerSchema),
    providerSchema,
    z.array(modelWithProviderSchema),
    modelSchema,
    z.strictObject({ addedCount: z.number().int().nonnegative() }),
    z.boolean(),
    z.null(),
]);
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({ requestId: z.uuid(), ok: z.literal(true), result: resultSchema }),
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(false),
        code: z.enum(modelAdministrationErrorCodes),
        outcome: z.enum(['none', 'unknown']),
    }),
]);
type Reply = z.infer<typeof replySchema>;

/** Settings-only profile commands; main owns the database and connection instances. */
export function createModelAdministrationWindow(input: {
    label: string | null;
    signal: AbortSignal;
    owner?(signal: AbortSignal): Promise<ModelAdministration>;
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
            input.warn('MODEL_ADMINISTRATION_FAILED');
        } catch {
            /* Passive diagnostics. */
        }
    };
    const failure = (requestId: string, error: ModelAdministrationError): Reply => ({
        requestId,
        ok: false,
        code: error.code,
        outcome: error.outcome,
    });
    async function run(command: Command) {
        if (disposed || !input.owner || running >= LIMIT)
            throw new ModelAdministrationError('MODEL_ADMINISTRATION_UNAVAILABLE');
        running++;
        const deadline = new AbortController();
        const timer = setTimeout(
            () =>
                deadline.abort(
                    new ModelAdministrationError('MODEL_ADMINISTRATION_UNCONFIRMED', 'unknown')
                ),
            TIMEOUT_MS
        );
        const combined = combineAbortSignals([input.signal, deadline.signal]);
        try {
            return await awaitAbortable(async () => {
                const owner = await input.owner!(combined.signal);
                combined.signal.throwIfAborted();
                let result;
                switch (command.operation) {
                    case 'providers':
                        result = await owner.findAllProvidersSorted();
                        break;
                    case 'provider':
                        result = await owner.findProviderById({ id: command.id });
                        break;
                    case 'provider-create':
                        result = await owner.createProvider(command.data);
                        break;
                    case 'provider-update':
                        await owner.updateProvider({
                            id: command.id,
                            providerPatch: command.patch,
                        });
                        break;
                    case 'provider-delete':
                        result = await owner.deleteProvider({ id: command.id });
                        break;
                    case 'default':
                        result = await owner.findDefaultModel();
                        break;
                    case 'models':
                        result = await owner.findModelsWithProvider({
                            providerId: command.providerId,
                        });
                        break;
                    case 'model-create':
                        result = await owner.createModel(command.data);
                        break;
                    case 'model-update':
                        await owner.updateModel({ id: command.id, modelPatch: command.patch });
                        break;
                    case 'model-delete':
                        result = await owner.deleteModel({ id: command.id });
                        break;
                    case 'set-default':
                        await owner.setDefaultModel({ modelId: command.id });
                        break;
                    case 'refresh-save':
                        result = await owner.persistRefreshedModels({
                            providerId: command.providerId,
                            models: command.models,
                        });
                        break;
                }
                return resultSchema.parse(result ?? null);
            }, combined.signal);
        } catch (error) {
            if (error instanceof ModelAdministrationError) throw error;
            throw new ModelAdministrationError('MODEL_ADMINISTRATION_FAILED', 'unknown');
        } finally {
            clearTimeout(timer);
            combined.dispose();
            running--;
        }
    }
    async function serve(payload: unknown) {
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success || disposed) return;
        const request = parsed.data;
        const now = Date.now();
        for (const [key, value] of served)
            if (value.completedAt !== undefined && now - value.completedAt >= 300_000)
                served.delete(key);
        const command = JSON.stringify(request.command);
        let entry = served.get(request.requestId);
        if (entry && entry.command !== command) return;
        if (!entry) {
            if (served.size >= 64) {
                for (const [key, value] of served)
                    if (value.completedAt !== undefined) {
                        served.delete(key);
                        break;
                    }
            }
            if (served.size >= 64) {
                await emitWindowEvent(
                    'settings',
                    REPLY_EVENT,
                    failure(
                        request.requestId,
                        new ModelAdministrationError('MODEL_ADMINISTRATION_UNAVAILABLE')
                    )
                ).catch(warn);
                return;
            }
            entry = {
                command,
                completion: run(request.command).then(
                    (result): Reply => ({ requestId: request.requestId, ok: true, result }),
                    (error: ModelAdministrationError) => failure(request.requestId, error)
                ),
            };
            served.set(request.requestId, entry);
            const current = entry;
            void entry.completion.then(() => {
                current.completedAt = Date.now();
            });
        }
        const reply = await entry.completion;
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
        )
            throw new ModelAdministrationError('MODEL_ADMINISTRATION_UNAVAILABLE');
        const requestId = crypto.randomUUID();
        return new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
            const finish = (reply: Reply) => {
                if (!pending.delete(requestId)) return;
                clearTimeout(timer);
                if (reply.ok) resolve(reply.result);
                else reject(new ModelAdministrationError(reply.code, reply.outcome));
            };
            const timer = setTimeout(
                () =>
                    finish(
                        failure(
                            requestId,
                            new ModelAdministrationError(
                                'MODEL_ADMINISTRATION_UNCONFIRMED',
                                'unknown'
                            )
                        )
                    ),
                TIMEOUT_MS
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
                            new ModelAdministrationError('MODEL_ADMINISTRATION_UNAVAILABLE')
                        )
                    )
                );
        });
    }
    const api = Object.freeze<ModelAdministration>({
        findAllProvidersSorted: async () =>
            z.array(providerSchema).parse(await request({ operation: 'providers' })),
        findProviderById: async ({ id }) =>
            providerSchema.nullable().parse(await request({ operation: 'provider', id })) ??
            undefined,
        createProvider: async (data) =>
            providerSchema.parse(await request({ operation: 'provider-create', data })),
        updateProvider: async ({ id, providerPatch }) => {
            await request({ operation: 'provider-update', id, patch: providerPatch });
        },
        deleteProvider: async ({ id }) =>
            z.boolean().parse(await request({ operation: 'provider-delete', id })),
        findDefaultModel: async () =>
            modelSchema.nullable().parse(await request({ operation: 'default' })) ?? undefined,
        findModelsWithProvider: async (options) =>
            z
                .array(modelWithProviderSchema)
                .parse(await request({ operation: 'models', providerId: options?.providerId })),
        createModel: async (data) =>
            modelSchema.parse(await request({ operation: 'model-create', data })),
        updateModel: async ({ id, modelPatch }) => {
            await request({ operation: 'model-update', id, patch: modelPatch });
        },
        deleteModel: async ({ id }) =>
            z.boolean().parse(await request({ operation: 'model-delete', id })),
        setDefaultModel: async ({ modelId }) => {
            await request({ operation: 'set-default', id: modelId });
        },
        persistRefreshedModels: async ({ providerId, models }) =>
            z
                .object({ addedCount: z.number() })
                .parse(
                    await request({ operation: 'refresh-save', providerId, models: [...models] })
                ),
    });
    function dispose() {
        if (disposed) return;
        disposed = true;
        stop?.();
        stop = undefined;
        for (const [requestId, finish] of [...pending])
            finish(
                failure(
                    requestId,
                    new ModelAdministrationError('MODEL_ADMINISTRATION_UNCONFIRMED', 'unknown')
                )
            );
        served.clear();
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, ready, dispose });
}
