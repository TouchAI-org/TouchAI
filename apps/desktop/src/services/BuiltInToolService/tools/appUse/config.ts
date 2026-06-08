// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { parseToolConfigJson, z } from '../../utils/toolSchema';
import { APP_USE_ADAPTER_IDS, type AppUseAdapterId } from './constants';

export type AppUseMode = 'read_only' | 'interactive';
export type AppUseApprovalMode = 'always';
export type AppUseReadScope = 'active';

export type AppUseAdapterConfig = Record<AppUseAdapterId, boolean>;

export interface AppUseToolConfig {
    mode: AppUseMode;
    adapters: AppUseAdapterConfig;
    mutatingApprovalMode: AppUseApprovalMode;
    readScope: AppUseReadScope;
    allowBackgroundOperation: boolean;
    allowRawAutomation: false;
    timeoutMs: number;
    maxOutputChars: number;
}

export const DEFAULT_APP_USE_ADAPTER_CONFIG = Object.fromEntries(
    APP_USE_ADAPTER_IDS.map((adapterId) => [adapterId, false])
) as AppUseAdapterConfig;

export const DEFAULT_APP_USE_TOOL_CONFIG: AppUseToolConfig = {
    mode: 'read_only',
    adapters: { ...DEFAULT_APP_USE_ADAPTER_CONFIG },
    mutatingApprovalMode: 'always',
    readScope: 'active',
    allowBackgroundOperation: false,
    allowRawAutomation: false,
    timeoutMs: 15000,
    maxOutputChars: 12000,
};

const appUseToolConfigSchema = z
    .object({
        mode: z.enum(['read_only', 'interactive']).optional().catch(undefined),
        adapters: z.record(z.string(), z.boolean()).optional().catch(undefined),
        mutatingApprovalMode: z.literal('always').optional().catch(undefined),
        readScope: z.literal('active').optional().catch(undefined),
        allowBackgroundOperation: z.boolean().optional().catch(undefined),
        allowRawAutomation: z.boolean().optional().catch(undefined),
        timeoutMs: z.number().int().min(1000).max(120000).optional().catch(undefined),
        maxOutputChars: z.number().int().min(1000).max(50000).optional().catch(undefined),
    })
    .transform((value): AppUseToolConfig => {
        const adapters = { ...DEFAULT_APP_USE_ADAPTER_CONFIG };
        for (const adapterId of APP_USE_ADAPTER_IDS) {
            adapters[adapterId] = value.adapters?.[adapterId] === true;
        }

        return {
            mode: value.mode ?? DEFAULT_APP_USE_TOOL_CONFIG.mode,
            adapters,
            mutatingApprovalMode: 'always',
            readScope: 'active',
            allowBackgroundOperation:
                value.allowBackgroundOperation ??
                DEFAULT_APP_USE_TOOL_CONFIG.allowBackgroundOperation,
            allowRawAutomation: false,
            timeoutMs: value.timeoutMs ?? DEFAULT_APP_USE_TOOL_CONFIG.timeoutMs,
            maxOutputChars: value.maxOutputChars ?? DEFAULT_APP_USE_TOOL_CONFIG.maxOutputChars,
        };
    });

export function parseAppUseToolConfig(configJson: string | null): AppUseToolConfig {
    return parseToolConfigJson(appUseToolConfigSchema, configJson, DEFAULT_APP_USE_TOOL_CONFIG);
}

export function serializeAppUseToolConfig(config: AppUseToolConfig): string {
    return JSON.stringify({
        mode: config.mode,
        adapters: config.adapters,
        mutatingApprovalMode: 'always',
        readScope: 'active',
        allowBackgroundOperation: config.allowBackgroundOperation,
        allowRawAutomation: false,
        timeoutMs: config.timeoutMs,
        maxOutputChars: config.maxOutputChars,
    });
}
