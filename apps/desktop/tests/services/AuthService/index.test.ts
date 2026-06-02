import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, openUrlMock } = vi.hoisted(() => ({
    fetchMock: vi.fn(),
    openUrlMock: vi.fn(),
}));

const eventServiceMock = vi.hoisted(() => ({
    emit: vi.fn().mockResolvedValue(undefined),
}));

const queriesMock = vi.hoisted(() => ({
    createModels: vi.fn(),
    findAllProvidersSorted: vi.fn(),
    findDefaultModel: vi.fn(),
    findModelsWithProvider: vi.fn(),
    reassignModelsAndDeleteProvider: vi.fn(),
    setDefaultModel: vi.fn(),
    updateProvider: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
    fetch: fetchMock,
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: openUrlMock,
}));

vi.mock('@/database/queries', () => queriesMock);

vi.mock('@/services/EventService', () => ({
    AppEvent: {
        AI_MODELS_UPDATED: 'AI_MODELS_UPDATED',
    },
    eventService: eventServiceMock,
}));

describe('AuthService managed TouchAI Hub flow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queriesMock.findAllProvidersSorted.mockResolvedValue([
            {
                id: 320,
                name: 'Xiaomi MiMo',
                driver: 'mimo',
                api_endpoint: 'https://hub.touch-ai.org/api/v1',
                api_key: null,
                config_json: null,
                logo: 'mimo.png',
                enabled: 1,
                is_builtin: 1,
                created_at: '',
                updated_at: '',
            },
        ]);
        queriesMock.findDefaultModel.mockResolvedValue(null);
        queriesMock.findModelsWithProvider.mockResolvedValue([]);
        queriesMock.createModels.mockResolvedValue(undefined);
        queriesMock.reassignModelsAndDeleteProvider.mockResolvedValue(true);
        queriesMock.setDefaultModel.mockResolvedValue(undefined);
        queriesMock.updateProvider.mockResolvedValue(undefined);
        openUrlMock.mockResolvedValue(undefined);
        window.sessionStorage.clear();
    });

    it('returns managed auth status from the managed provider row', async () => {
        const { getManagedAuthState } = await import('@/services/AuthService');

        await expect(getManagedAuthState()).resolves.toEqual({
            providerId: 320,
            isLoggedIn: false,
            login: null,
            avatarUrl: null,
        });
    });

    it('opens the TouchAI Hub desktop login entry', async () => {
        const { openManagedLogin } = await import('@/services/AuthService');

        await openManagedLogin();

        expect(openUrlMock).toHaveBeenCalledWith('https://hub.touch-ai.org/desktop/login');
    });

    it('normalizes the builtin mimo provider and removes legacy mimo activity providers during bootstrap', async () => {
        queriesMock.findAllProvidersSorted.mockResolvedValue([
            {
                id: 320,
                name: 'Xiaomi MiMo',
                driver: 'mimo',
                api_endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
                api_key: 'tp-cewp7d6lctrl3ecg9og26xyg78t4ll6mth9rdsh810unjodu',
                config_json: null,
                logo: 'mimo.png',
                enabled: 1,
                is_builtin: 1,
                created_at: '',
                updated_at: '',
            },
            {
                id: 321,
                name: 'TouchAI MiMo 活动',
                driver: 'touchai-mimo',
                api_endpoint: 'https://hub.touch-ai.org/api/v1',
                api_key: null,
                config_json: null,
                logo: 'mimo.png',
                enabled: 1,
                is_builtin: 1,
                created_at: '',
                updated_at: '',
            },
        ]);

        const { initializeManagedProviderState } = await import('@/services/AuthService');
        await initializeManagedProviderState();

        expect(queriesMock.reassignModelsAndDeleteProvider).toHaveBeenCalledWith({
            sourceProviderId: 321,
            targetProviderId: 320,
        });
        expect(queriesMock.updateProvider).toHaveBeenCalledWith({
            id: 320,
            providerPatch: {
                name: 'Xiaomi MiMo',
                api_endpoint: 'https://hub.touch-ai.org/api/v1',
                api_key: null,
                config_json: JSON.stringify({
                    touchAiMode: 'custom',
                    touchAiCustom: {
                        apiEndpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
                        apiKey: 'tp-cewp7d6lctrl3ecg9og26xyg78t4ll6mth9rdsh810unjodu',
                    },
                }),
                logo: 'mimo.png',
                enabled: 1,
            },
        });
        expect(queriesMock.createModels).toHaveBeenCalledWith([
            {
                provider_id: 320,
                name: 'mimo-v2.5',
                model_id: 'mimo-v2.5',
                is_default: 0,
            },
            {
                provider_id: 320,
                name: 'mimo-v2.5-pro',
                model_id: 'mimo-v2.5-pro',
                is_default: 0,
            },
        ]);
    });

    it('clears the managed provider token on logout', async () => {
        queriesMock.findAllProvidersSorted.mockResolvedValue([
            {
                id: 320,
                name: 'Xiaomi MiMo',
                driver: 'mimo',
                api_endpoint: 'https://hub.touch-ai.org/api/v1',
                api_key: 'tai-live-key',
                config_json: null,
                logo: 'mimo.png',
                enabled: 1,
                is_builtin: 1,
                created_at: '',
                updated_at: '',
            },
        ]);

        const { logoutManagedAuth } = await import('@/services/AuthService');
        await logoutManagedAuth();

        expect(queriesMock.updateProvider).toHaveBeenCalledWith({
            id: 320,
            providerPatch: {
                api_key: null,
                api_endpoint: 'https://hub.touch-ai.org/api/v1',
                config_json: JSON.stringify({
                    touchAiMode: 'managed',
                }),
            },
        });
        expect(eventServiceMock.emit).toHaveBeenCalledWith('AI_MODELS_UPDATED', {
            updatedAt: expect.any(Number),
        });
    });

    it('ignores unrelated callback URLs', async () => {
        const { completeManagedLogin } = await import('@/services/AuthService');

        await expect(
            completeManagedLogin('https://hub.touch-ai.org/auth/github/callback')
        ).resolves.toBe(false);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(queriesMock.updateProvider).not.toHaveBeenCalled();
    });

    it('exchanges a desktop callback code for the managed key and stores it locally', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    apiKey: 'ta_live_long_lived_key',
                    key: {
                        githubLogin: 'octocat',
                        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
                    },
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                }
            )
        );

        const { completeManagedLogin } = await import('@/services/AuthService');

        await expect(
            completeManagedLogin('touchai://hub/auth/callback?code=exchange-code')
        ).resolves.toBe(true);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://hub.touch-ai.org/api/desktop/key/exchange',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ code: 'exchange-code' }),
            }
        );
        expect(queriesMock.updateProvider).toHaveBeenCalledWith({
            id: 320,
            providerPatch: {
                api_key: 'ta_live_long_lived_key',
                api_endpoint: 'https://hub.touch-ai.org/api/v1',
                config_json: JSON.stringify({
                    touchAiMode: 'managed',
                    managedAuth: {
                        login: 'octocat',
                        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
                    },
                }),
            },
        });
    });

    it('does not exchange the same desktop callback code twice in one app session', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    apiKey: 'ta_live_long_lived_key',
                    key: {
                        githubLogin: 'octocat',
                    },
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                }
            )
        );

        const { completeManagedLogin } = await import('@/services/AuthService');

        await expect(
            completeManagedLogin('touchai://hub/auth/callback?code=exchange-code')
        ).resolves.toBe(true);
        fetchMock.mockClear();
        queriesMock.updateProvider.mockClear();

        await expect(
            completeManagedLogin('touchai://hub/auth/callback?code=exchange-code')
        ).resolves.toBe(false);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(queriesMock.updateProvider).not.toHaveBeenCalled();
    });

    it('rejects a desktop exchange response that does not return a ta_live key', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    apiKey: 'sk-not-allowed',
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                }
            )
        );

        const { completeManagedLogin } = await import('@/services/AuthService');

        await expect(
            completeManagedLogin('touchai://hub/auth/callback?code=exchange-code')
        ).rejects.toThrow('TouchAI Hub key exchange returned an invalid API key.');
    });

    it('surfaces hub exchange errors with the returned message', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    error: 'GitHub token exchange failed.',
                }),
                {
                    status: 403,
                    headers: {
                        'content-type': 'application/json',
                    },
                }
            )
        );

        const { completeManagedLogin } = await import('@/services/AuthService');

        await expect(
            completeManagedLogin('touchai://hub/auth/callback?code=exchange-code')
        ).rejects.toThrow('GitHub token exchange failed.');
    });

    it('invalidates the managed token when the gateway marks the session as expired', async () => {
        const { invalidateManagedAuthForError } = await import('@/services/AuthService');

        await expect(
            invalidateManagedAuthForError({
                providerId: 320,
                error: {
                    details: {
                        requiresRelogin: true,
                        gatewayCode: 'authentication_expired',
                    },
                },
            })
        ).resolves.toBe(true);

        expect(queriesMock.updateProvider).toHaveBeenCalledWith({
            id: 320,
            providerPatch: {
                api_key: null,
                api_endpoint: 'https://hub.touch-ai.org/api/v1',
                config_json: JSON.stringify({
                    touchAiMode: 'managed',
                }),
            },
        });
        expect(eventServiceMock.emit).toHaveBeenCalledWith('AI_MODELS_UPDATED', {
            updatedAt: expect.any(Number),
        });
    });
});
