// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderApiTargets, ProviderDriver } from '../contracts/model';
import type { ReasoningProtocol } from '../contracts/reasoning';

/** Base normalization never appends a provider-specific path. */
export function normalizeProviderBaseUrl(baseUrl: string): string {
    let end = baseUrl.length;
    while (end > 0 && baseUrl[end - 1] === '/') end -= 1;
    return baseUrl.slice(0, end);
}

export function resolveOpenAiStyleSdkBaseUrl(normalizedBaseUrl: string): string {
    if (!normalizedBaseUrl) {
        return '';
    }

    try {
        const { pathname } = new URL(normalizedBaseUrl);
        return pathname && pathname !== '/' ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    } catch {
        return `${normalizedBaseUrl}/v1`;
    }
}

/** Shared by endpoint preview and the actual drivers; no SDK or connection is loaded. */
export function getProviderApiTargets(
    driver: ProviderDriver,
    endpoint: string,
    reasoningFormat?: ReasoningProtocol
): ProviderApiTargets {
    const normalizedBaseUrl = normalizeProviderBaseUrl(endpoint);
    if (!normalizedBaseUrl)
        return {
            normalizedBaseUrl: '',
            sdkBaseUrl: '',
            generationTarget: '',
            discoveryTarget: '',
        };
    let sdkBaseUrl: string;
    let generationPath = '/chat/completions';
    const withRootPath = (suffix: string) => {
        try {
            const { pathname } = new URL(normalizedBaseUrl);
            return pathname && pathname !== '/' ? normalizedBaseUrl : normalizedBaseUrl + suffix;
        } catch {
            return normalizedBaseUrl + suffix;
        }
    };
    switch (driver) {
        case 'openai':
            sdkBaseUrl = resolveOpenAiStyleSdkBaseUrl(normalizedBaseUrl);
            generationPath =
                reasoningFormat === undefined || reasoningFormat === 'openai-responses'
                    ? '/responses'
                    : '/chat/completions';
            break;
        case 'anthropic':
            sdkBaseUrl = withRootPath('/v1');
            generationPath = '/messages';
            break;
        case 'anthropic-compatible':
            sdkBaseUrl = normalizedBaseUrl;
            generationPath = '/messages';
            break;
        case 'google':
            sdkBaseUrl = `${normalizedBaseUrl}/v1beta`;
            generationPath = '/models/{model}:streamGenerateContent';
            break;
        case 'deepseek':
            sdkBaseUrl = normalizedBaseUrl;
            break;
        case 'alibaba':
            sdkBaseUrl = withRootPath('/compatible-mode/v1');
            break;
        case 'minimax':
            sdkBaseUrl = withRootPath('/anthropic/v1');
            generationPath = '/messages';
            break;
        case 'zhipu':
            sdkBaseUrl = withRootPath('/api/paas/v4');
            break;
        case 'openai-compatible':
        case 'mimo':
        case 'xai':
        case 'moonshot':
            sdkBaseUrl = withRootPath('/v1');
            break;
        default:
            throw new Error(`Unknown provider driver: ${String(driver)}`);
    }
    return {
        normalizedBaseUrl,
        sdkBaseUrl,
        generationTarget: sdkBaseUrl + generationPath,
        discoveryTarget: `${sdkBaseUrl}/models`,
    };
}
