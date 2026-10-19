// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export { normalizeProviderBaseUrl } from './ai-sdk/base';
export { createTauriFetch } from './ai-sdk/tauriFetch';
export { getProviderAttachmentCapabilities } from './capabilities';
export { MIMO_API_BASE_URL, parseProviderConfigJson } from './config';
export { createProviderFromRegistry } from './drivers';
export {
    getProviderDriverDefinition,
    getProviderDriverDefinitions,
    isProviderDriver,
    parseProviderDriver,
    type ProviderDriverDefinition,
    providerDriverDefinitions,
} from './driverCatalog';
export type {
    AiProvider,
    AiProviderConfig,
    ModelCapabilities,
    ModelInfo,
    ProviderApiTargets,
    ProviderAttachmentCapabilities,
    ProviderAttachmentFileRefStrategy,
    ProviderConfigJson,
} from './types';
export { resolveOpenAiStyleSdkBaseUrl } from './utils';
