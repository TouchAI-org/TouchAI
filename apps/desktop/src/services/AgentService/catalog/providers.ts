// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';
import type { ProviderDriver } from '@database/schema';

import {
    type AiProvider,
    createProviderFromRegistry,
    parseProviderConfigJson,
    parseProviderDriver,
} from '../infrastructure/providers';

/**
 * 按服务商驱动创建 provider 实例。
 */
export function createProviderInstance(
    providerDriver: ProviderDriver,
    apiEndpoint: string,
    apiKey?: string | null,
    configJson?: string | null
): AiProvider {
    return createProviderFromRegistry(providerDriver, {
        apiEndpoint,
        apiKey: apiKey || undefined,
        config: parseProviderConfigJson(configJson),
    });
}

/**
 * 按模型记录创建对应的 provider 实例。
 */
export function createProviderForModel(model: ModelWithProvider): AiProvider {
    return createProviderInstance(
        parseProviderDriver(model.provider_driver),
        model.api_endpoint,
        model.api_key,
        model.provider_config_json
    );
}
