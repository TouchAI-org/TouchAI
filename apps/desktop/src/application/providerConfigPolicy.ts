// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderConfigJson } from '@/contracts/providerConfig';
import { safeParseJsonWithSchema, z } from '@/utils/zod';

export const TOUCHAI_HUB_GATEWAY_BASE_URL = 'https://hub.touch-ai.org/api/v1';
export const MIMO_CUSTOM_API_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';

const providerConfigJsonSchema = z.object({
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
    managedAuth: z
        .object({
            login: z.string().trim().min(1).optional(),
            avatarUrl: z.string().trim().min(1).optional(),
        })
        .optional(),
    touchAiMode: z.enum(['managed', 'custom']).optional(),
    touchAiCustom: z
        .object({
            apiEndpoint: z.string().trim().min(1).optional(),
            apiKey: z.string().trim().min(1).optional(),
        })
        .optional(),
});

export function parseProviderConfigJson(configJson?: string | null): ProviderConfigJson {
    return safeParseJsonWithSchema(providerConfigJsonSchema, configJson, {});
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
}

export function isTouchAiManagedMode(config: ProviderConfigJson, baseUrl: string): boolean {
    if (config.touchAiMode === 'custom') {
        return false;
    }

    const isHubEndpoint = normalizeBaseUrl(baseUrl) === TOUCHAI_HUB_GATEWAY_BASE_URL;

    if (config.touchAiMode === 'managed') {
        return isHubEndpoint;
    }

    return isHubEndpoint;
}
