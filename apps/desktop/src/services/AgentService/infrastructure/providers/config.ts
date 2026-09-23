// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { safeParseJsonWithSchema, z } from '@/utils/zod';

import type { ProviderConfigJson } from './types';

export const MIMO_API_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';

const providerConfigJsonSchema = z.object({
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
});

export function parseProviderConfigJson(configJson?: string | null): ProviderConfigJson {
    return safeParseJsonWithSchema(providerConfigJsonSchema, configJson, {});
}
