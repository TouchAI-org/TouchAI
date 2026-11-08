// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export { normalizeProviderBaseUrl } from './ai-sdk/base';
export { createTauriFetch } from './ai-sdk/tauriFetch';
export { getProviderAttachmentCapabilities } from './capabilities';
export { MIMO_API_BASE_URL, parseProviderConfigJson } from './config';
export {
    getProviderDriverDefinition,
    getProviderDriverDefinitions,
    isProviderDriver,
    parseProviderDriver,
    type ProviderDriverDefinition,
    providerDriverDefinitions,
} from './driverCatalog';
// 注意：此处不转出 `./drivers`。实例化入口会静态引入所有厂商 adapter，
// 只应由真正发请求的模块（catalog / executor）直接导入，避免设置页把它们拉进首屏。
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
