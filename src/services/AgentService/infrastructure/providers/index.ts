// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export { normalizeProviderBaseUrl, parseProviderConfigJson } from './ai-sdk/base';
export { createTauriFetch } from './ai-sdk/tauriFetch';
export { getProviderAttachmentCapabilities } from './capabilities';
export {
    createProviderFromRegistry,
    getProviderDriverDefinition,
    isProviderDriver,
    parseProviderDriver,
    type ProviderDriverDefinition,
    providerDriverDefinitions,
} from './drivers';
export type {
    AiProvider,
    AiProviderConfig,
    ModelInfo,
    ProviderApiTargets,
    ProviderAttachmentCapabilities,
    ProviderAttachmentFileRefStrategy,
    ProviderConfigJson,
} from './types';
