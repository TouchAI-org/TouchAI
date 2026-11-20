import { isProviderDriver } from '@touchai/models/catalog';
import type { ModelInfo, ProviderDriver } from '@touchai/models/contracts';
import { z } from 'zod';

const id = z.number().int().positive();
const flag = z
    .number()
    .int()
    .refine((value) => value === 0 || value === 1);
export const providerSchema = z.object({
    id,
    name: z.string(),
    driver: z.custom<ProviderDriver>(isProviderDriver),
    api_endpoint: z.string(),
    api_key: z.string().nullable(),
    config_json: z.string().nullable(),
    logo: z.string(),
    enabled: z.number(),
    is_builtin: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
});
const providerFields = providerSchema
    .omit({ id: true, created_at: true, updated_at: true, is_builtin: true })
    .extend({
        name: z.string().trim().min(1),
        api_endpoint: z.string().trim().min(1),
        enabled: flag,
    });
export const providerDraftSchema = providerFields
    .partial()
    .required({ name: true, driver: true, api_endpoint: true, logo: true })
    .extend({ is_builtin: z.literal(0).optional() })
    .strict();
export const providerPatchSchema = providerFields.partial().strict();

export const modelSchema = z.object({
    id,
    provider_id: id,
    name: z.string(),
    model_id: z.string(),
    is_default: z.number(),
    last_used_at: z.string().nullable(),
    attachment: z.number(),
    modalities: z.string().nullable(),
    open_weights: z.number(),
    reasoning: z.number(),
    reasoning_options: z.string().nullable(),
    release_date: z.string().nullable(),
    temperature: z.number(),
    tool_call: z.number(),
    knowledge: z.string().nullable(),
    context_limit: z.number().nullable(),
    output_limit: z.number().nullable(),
    is_custom_metadata: z.number(),
    upstream_metadata: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
});
const modelFields = modelSchema
    .omit({ id: true, created_at: true, updated_at: true, is_default: true })
    .extend({ name: z.string().min(1), model_id: z.string().min(1) });
export const modelDraftSchema = modelFields
    .partial()
    .required({ provider_id: true, name: true, model_id: true })
    .extend({ is_default: z.literal(0).optional() })
    .strict();
export const modelPatchSchema = modelFields
    .omit({ provider_id: true, upstream_metadata: true })
    .partial()
    .strict();
export const modelWithProviderSchema = modelSchema.extend({
    provider_name: z.string(),
    provider_driver: providerSchema.shape.driver,
    api_endpoint: z.string(),
    api_key: z.string().nullable(),
    provider_config_json: z.string().nullable(),
    provider_enabled: z.number(),
    provider_logo: z.string(),
});
export type Provider = z.infer<typeof providerSchema>;
export type NewProvider = z.infer<typeof providerDraftSchema>;
export type ProviderPatch = z.infer<typeof providerPatchSchema>;
export type Model = z.infer<typeof modelSchema>;
export type NewModel = z.infer<typeof modelDraftSchema>;
export type ModelPatch = z.infer<typeof modelPatchSchema>;
export type ModelWithProvider = z.infer<typeof modelWithProviderSchema>;

export const modelAdministrationErrorCodes = [
    'MODEL_ADMINISTRATION_UNAVAILABLE',
    'MODEL_ADMINISTRATION_UNCONFIRMED',
    'MODEL_ADMINISTRATION_FAILED',
    'MODEL_NOT_FOUND',
    'PROVIDER_NOT_FOUND',
    'PROVIDER_HAS_DEFAULT_MODEL',
    'BUILTIN_PROVIDER',
] as const;
export class ModelAdministrationError extends Error {
    constructor(
        readonly code: (typeof modelAdministrationErrorCodes)[number],
        readonly outcome: 'none' | 'unknown' = 'none'
    ) {
        super(code);
        this.name = 'ModelAdministrationError';
    }
}

/** Privileged configuration projection, supplied only to the settings window. */
export interface ModelAdministration {
    findAllProvidersSorted(): Promise<Provider[]>;
    findProviderById(input: { id: number }): Promise<Provider | undefined>;
    createProvider(data: NewProvider): Promise<Provider>;
    updateProvider(input: { id: number; providerPatch: ProviderPatch }): Promise<void>;
    deleteProvider(input: { id: number }): Promise<boolean>;
    findDefaultModel(): Promise<Model | undefined>;
    findModelsWithProvider(input?: { providerId?: number }): Promise<ModelWithProvider[]>;
    createModel(data: NewModel): Promise<Model>;
    updateModel(input: { id: number; modelPatch: ModelPatch }): Promise<void>;
    deleteModel(input: { id: number }): Promise<boolean>;
    setDefaultModel(input: { modelId: number }): Promise<void>;
    persistRefreshedModels(input: {
        providerId: number;
        models: readonly ModelInfo[];
    }): Promise<{ addedCount: number }>;
}
