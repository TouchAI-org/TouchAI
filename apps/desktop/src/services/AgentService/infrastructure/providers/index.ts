// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export { normalizeProviderBaseUrl } from './ai-sdk/base';
export { createTauriFetch } from './ai-sdk/tauriFetch';
export { getProviderAttachmentCapabilities } from './capabilities';
export {
    isTouchAiManagedMode,
    parseProviderConfigJson,
    TOUCHAI_HUB_GATEWAY_BASE_URL,
} from './config';
export {
    createProviderFromRegistry,
    getProviderDriverDefinition,
    getProviderDriverDefinitions,
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
export { resolveOpenAiStyleSdkBaseUrl } from './utils';
