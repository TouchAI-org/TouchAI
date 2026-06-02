// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { fetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';

import {
    createModels,
    findAllProvidersSorted,
    findDefaultModel,
    findModelsWithProvider,
    reassignModelsAndDeleteProvider,
    setDefaultModel,
    updateProvider,
} from '@/database/queries';
import {
    isTouchAiManagedModel,
    parseProviderConfigJson,
    TOUCHAI_HUB_GATEWAY_BASE_URL,
    TOUCHAI_HUB_MANAGED_MODELS,
} from '@/services/AgentService/infrastructure/providers/config';
import type { ProviderConfigJson } from '@/services/AgentService/infrastructure/providers/types';
import { AppEvent, eventService } from '@/services/EventService';

const MIMO_DRIVER = 'mimo';
const LEGACY_MIMO_DRIVER = 'touchai-mimo';
const HUB_LOGIN_URL = 'https://hub.touch-ai.org/desktop/login';
const HUB_KEY_EXCHANGE_URL = 'https://hub.touch-ai.org/api/desktop/key/exchange';
const HUB_API_BASE_URL = TOUCHAI_HUB_GATEWAY_BASE_URL;
const HUB_API_KEY_PREFIX = 'ta_live_';
const MANAGED_PROVIDER_NAME = 'Xiaomi MiMo';
const MANAGED_PROVIDER_LOGO = 'mimo.png';
const MANAGED_AUTH_FAILURE_CODES = new Set([
    'invalid_or_revoked_api_key',
    'invalid_signature',
    'authentication_expired',
    'replay_detected',
]);

type ManagedProviderRow = Awaited<ReturnType<typeof findAllProvidersSorted>>[number];
type ManagedProviderConfig = ProviderConfigJson;
type MutableManagedProviderRow = ManagedProviderRow & {
    driver: string;
};

export interface ManagedAuthState {
    providerId: number | null;
    isLoggedIn: boolean;
    login: string | null;
    avatarUrl: string | null;
}

function parseManagedProviderConfig(configJson: string | null | undefined): ManagedProviderConfig {
    return parseProviderConfigJson(configJson);
}

function normalizeOptionalString(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

function isManagedApiKey(value: string | null | undefined): boolean {
    return normalizeOptionalString(value).startsWith(HUB_API_KEY_PREFIX);
}

function toManagedProviderConfigJson(config: ManagedProviderConfig): string | null {
    const nextConfig: ProviderConfigJson = {
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.queryParams ? { queryParams: config.queryParams } : {}),
        ...(config.managedAuth ? { managedAuth: config.managedAuth } : {}),
        ...(config.touchAiMode ? { touchAiMode: config.touchAiMode } : {}),
        ...(config.touchAiCustom ? { touchAiCustom: config.touchAiCustom } : {}),
    };

    return Object.keys(nextConfig).length > 0 ? JSON.stringify(nextConfig) : null;
}

function buildManagedProviderConfigJson(
    provider: ManagedProviderRow | undefined,
    managedAuth: { login: string | null; avatarUrl: string | null } | null
): string | null {
    const parsedConfig = parseManagedProviderConfig(provider?.config_json);
    const nextConfig: ProviderConfigJson = {
        ...(parsedConfig.headers ? { headers: parsedConfig.headers } : {}),
        ...(parsedConfig.queryParams ? { queryParams: parsedConfig.queryParams } : {}),
        touchAiMode: 'managed',
        ...(parsedConfig.touchAiCustom ? { touchAiCustom: parsedConfig.touchAiCustom } : {}),
        ...(managedAuth
            ? {
                  managedAuth: {
                      ...(managedAuth.login ? { login: managedAuth.login } : {}),
                      ...(managedAuth.avatarUrl ? { avatarUrl: managedAuth.avatarUrl } : {}),
                  },
              }
            : {}),
    };

    return Object.keys(nextConfig).length > 0 ? JSON.stringify(nextConfig) : null;
}

function extractManagedAuthProfile(payload: unknown): {
    login: string | null;
    avatarUrl: string | null;
} {
    if (payload == null || typeof payload !== 'object') {
        return {
            login: null,
            avatarUrl: null,
        };
    }

    const record = payload as Record<string, unknown>;
    const loginCandidates = [
        record.githubLogin,
        record.github_login,
        record.username,
        record.login,
        record.displayName,
        record.display_name,
    ];
    const avatarCandidates = [record.avatarUrl, record.avatar_url, record.avatar, record.image];

    const login =
        loginCandidates.find(
            (value): value is string => typeof value === 'string' && value.trim().length > 0
        ) ?? null;
    const avatarUrl =
        avatarCandidates.find(
            (value): value is string => typeof value === 'string' && value.trim().length > 0
        ) ?? null;

    return {
        login,
        avatarUrl,
    };
}

async function getManagedProvider(): Promise<ManagedProviderRow | undefined> {
    return (await findAllProvidersSorted()).find(
        (item) => item.driver === MIMO_DRIVER && item.is_builtin === 1
    );
}

function shouldNormalizeLegacyCustomConfig(
    provider: ManagedProviderRow,
    config: ManagedProviderConfig
): boolean {
    if (config.touchAiMode === 'custom') {
        return false;
    }

    const endpoint = normalizeOptionalString(provider.api_endpoint);
    const apiKey = normalizeOptionalString(provider.api_key);
    if (endpoint && endpoint !== HUB_API_BASE_URL) {
        return true;
    }

    return apiKey.length > 0 && !isManagedApiKey(apiKey);
}

function buildNormalizedManagedProviderPatch(provider: ManagedProviderRow) {
    const config = parseManagedProviderConfig(provider.config_json);
    const endpoint = normalizeOptionalString(provider.api_endpoint);
    const apiKey = normalizeOptionalString(provider.api_key);
    const nextConfig: ManagedProviderConfig = {
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.queryParams ? { queryParams: config.queryParams } : {}),
        ...(config.managedAuth ? { managedAuth: config.managedAuth } : {}),
    };

    let nextApiKey: string | null = isManagedApiKey(apiKey) ? apiKey : null;

    if (config.touchAiMode === 'custom' || shouldNormalizeLegacyCustomConfig(provider, config)) {
        const customApiEndpoint =
            normalizeOptionalString(config.touchAiCustom?.apiEndpoint) ||
            (endpoint && endpoint !== HUB_API_BASE_URL ? endpoint : '');
        const customApiKey =
            normalizeOptionalString(config.touchAiCustom?.apiKey) ||
            (apiKey && !isManagedApiKey(apiKey) ? apiKey : '');

        nextConfig.touchAiMode = 'custom';
        nextConfig.touchAiCustom =
            customApiEndpoint || customApiKey
                ? {
                      ...(customApiEndpoint ? { apiEndpoint: customApiEndpoint } : {}),
                      ...(customApiKey ? { apiKey: customApiKey } : {}),
                  }
                : undefined;
        nextApiKey = null;
    } else {
        nextConfig.touchAiMode = 'managed';
        if (config.touchAiCustom) {
            nextConfig.touchAiCustom = config.touchAiCustom;
        }
    }

    return {
        name: MANAGED_PROVIDER_NAME,
        api_endpoint: HUB_API_BASE_URL,
        api_key: nextApiKey,
        config_json: toManagedProviderConfigJson(nextConfig),
        logo: MANAGED_PROVIDER_LOGO,
        enabled: 1,
    };
}

function getPreferredManagedModelId(
    models: Array<{
        id: number;
        model_id: string;
    }>
): number | null {
    for (const managedModelId of TOUCHAI_HUB_MANAGED_MODELS) {
        const matchedModel = models.find((model) => model.model_id === managedModelId);
        if (matchedModel) {
            return matchedModel.id;
        }
    }

    return null;
}

async function ensureManagedProviderModels(providerId: number): Promise<void> {
    const existingModels = await findModelsWithProvider({ providerId });
    const existingModelIds = new Set(existingModels.map((model) => model.model_id));
    const missingModels = TOUCHAI_HUB_MANAGED_MODELS.filter(
        (modelId) => !existingModelIds.has(modelId)
    ).map((modelId) => ({
        provider_id: providerId,
        name: modelId,
        model_id: modelId,
        is_default: 0,
    }));

    if (missingModels.length > 0) {
        await createModels(missingModels);
    }

    const defaultModel = await findDefaultModel();
    if (
        !defaultModel ||
        defaultModel.provider_id !== providerId ||
        isTouchAiManagedModel(defaultModel.model_id)
    ) {
        return;
    }

    const managedModels =
        missingModels.length > 0 ? await findModelsWithProvider({ providerId }) : existingModels;
    const nextDefaultModelId = getPreferredManagedModelId(managedModels);
    if (nextDefaultModelId) {
        await setDefaultModel({ modelId: nextDefaultModelId });
    }
}

function extractManagedAuthFailureDetails(error: unknown): {
    gatewayCode: string;
    statusCode?: number;
} | null {
    if (error == null || typeof error !== 'object' || !('details' in error)) {
        return null;
    }

    const details = error.details;
    if (details == null || typeof details !== 'object') {
        return null;
    }

    const detailRecord = details as Record<string, unknown>;
    const requiresRelogin = detailRecord.requiresRelogin === true;
    const gatewayCode =
        typeof detailRecord.gatewayCode === 'string' ? detailRecord.gatewayCode : null;
    if (!requiresRelogin || !gatewayCode) {
        return null;
    }

    return {
        gatewayCode,
        statusCode:
            typeof detailRecord.statusCode === 'number' ? detailRecord.statusCode : undefined,
    };
}

async function notifyManagedAuthChanged(): Promise<void> {
    await eventService.emit(AppEvent.AI_MODELS_UPDATED, {
        updatedAt: Date.now(),
    });
}

function processedManagedCodeStorageKey(code: string): string {
    return `touchai.managed-auth.code.${code}`;
}

function hasProcessedManagedCode(code: string): boolean {
    if (typeof window === 'undefined' || !window.sessionStorage) {
        return false;
    }

    try {
        return window.sessionStorage.getItem(processedManagedCodeStorageKey(code)) === '1';
    } catch {
        return false;
    }
}

function markManagedCodeProcessed(code: string): void {
    if (typeof window === 'undefined' || !window.sessionStorage) {
        return;
    }

    try {
        window.sessionStorage.setItem(processedManagedCodeStorageKey(code), '1');
    } catch {
        // ignore storage failures
    }
}

export const TOUCHAI_MANAGED_API_BASE_URL = HUB_API_BASE_URL;

export async function initializeManagedProviderState(): Promise<void> {
    const providers = (await findAllProvidersSorted()) as MutableManagedProviderRow[];
    const migrations: Promise<unknown>[] = [];
    let managedProviderId: number | null = null;

    for (const provider of providers) {
        const providerDriver = (provider as { driver: string }).driver;

        if (providerDriver !== MIMO_DRIVER || provider.is_builtin !== 1) {
            continue;
        }

        managedProviderId ??= provider.id;
        migrations.push(
            updateProvider({
                id: provider.id,
                providerPatch: buildNormalizedManagedProviderPatch(provider),
            })
        );
    }

    if (managedProviderId !== null) {
        for (const provider of providers) {
            const providerDriver = (provider as { driver: string }).driver;
            if (providerDriver !== LEGACY_MIMO_DRIVER || provider.id === managedProviderId) {
                continue;
            }

            migrations.push(
                reassignModelsAndDeleteProvider({
                    sourceProviderId: provider.id,
                    targetProviderId: managedProviderId,
                })
            );
        }
    }

    await Promise.all(migrations);

    if (managedProviderId !== null) {
        await ensureManagedProviderModels(managedProviderId);
    }
}

export async function getManagedAuthState(): Promise<ManagedAuthState> {
    const provider = await getManagedProvider();
    const managedAuth = parseManagedProviderConfig(provider?.config_json).managedAuth;
    return {
        providerId: provider?.id ?? null,
        isLoggedIn: Boolean(provider?.api_key),
        login: provider?.api_key ? (managedAuth?.login ?? null) : null,
        avatarUrl: provider?.api_key ? (managedAuth?.avatarUrl ?? null) : null,
    };
}

export async function openManagedLogin(): Promise<void> {
    await openUrl(HUB_LOGIN_URL);
}

export async function clearManagedAuth(
    options: {
        providerId?: number | null;
        notify?: boolean;
    } = {}
): Promise<boolean> {
    const provider = await getManagedProvider();
    const providerId = options.providerId ?? provider?.id ?? null;
    if (!providerId) return false;

    await updateProvider({
        id: providerId,
        providerPatch: {
            api_key: null,
            api_endpoint: HUB_API_BASE_URL,
            config_json: buildManagedProviderConfigJson(provider, null),
        },
    });

    if (options.notify !== false) {
        await notifyManagedAuthChanged();
    }

    return true;
}

export async function logoutManagedAuth(): Promise<void> {
    await clearManagedAuth();
}

export async function invalidateManagedAuthForError(options: {
    providerId?: number | null;
    error: unknown;
}): Promise<boolean> {
    const details = extractManagedAuthFailureDetails(options.error);
    if (!details || !MANAGED_AUTH_FAILURE_CODES.has(details.gatewayCode)) {
        return false;
    }

    return await clearManagedAuth({
        providerId: options.providerId ?? null,
        notify: true,
    });
}

export async function completeManagedLogin(callbackUrl: string): Promise<boolean> {
    const parsed = new URL(callbackUrl);
    if (
        parsed.protocol !== 'touchai:' ||
        parsed.hostname !== 'hub' ||
        parsed.pathname !== '/auth/callback'
    ) {
        return false;
    }

    const code = parsed.searchParams.get('code');
    if (!code) {
        throw new Error('Missing TouchAI Hub exchange code.');
    }
    if (hasProcessedManagedCode(code)) {
        return false;
    }

    const state = await getManagedAuthState();
    if (!state.providerId) {
        throw new Error('TouchAI Hub managed provider is not available.');
    }

    const response = await fetch(HUB_KEY_EXCHANGE_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({ code }),
    });

    if (!response.ok) {
        let reason = 'TouchAI Hub key exchange failed.';
        try {
            const data = await response.json();
            if (data && typeof data.error === 'string') {
                reason = data.error;
            }
        } catch {
            // ignore parse failure
        }
        throw new Error(reason);
    }

    const data = await response.json();
    const apiKey = typeof data?.apiKey === 'string' ? data.apiKey : null;
    if (!apiKey) {
        throw new Error('TouchAI Hub key exchange returned no API key.');
    }
    if (!apiKey.startsWith(HUB_API_KEY_PREFIX)) {
        throw new Error('TouchAI Hub key exchange returned an invalid API key.');
    }

    const managedAuth = extractManagedAuthProfile(data?.key);
    const provider = await getManagedProvider();

    await updateProvider({
        id: state.providerId,
        providerPatch: {
            api_key: apiKey,
            api_endpoint: HUB_API_BASE_URL,
            config_json: buildManagedProviderConfigJson(provider, managedAuth),
        },
    });
    await ensureManagedProviderModels(state.providerId);
    markManagedCodeProcessed(code);

    return true;
}
