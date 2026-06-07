import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    appUseMock,
    appMountMock,
    completeManagedLoginMock,
    createAppMock,
    eventServiceEmitMock,
    getCurrentWindowMock,
    initializeManagedProviderStateMock,
    openSettingsWindowMock,
    settingsInitializeMock,
    appUpdateCheckNowMock,
    isLlmMetadataEmptyMock,
    getCurrentMock,
    initializeFontLoaderMock,
    initializeLoggerMock,
    syncAllModelsMetadataMock,
    updateModelMetadataMock,
    onOpenUrlMock,
    originalWindowOpenMock,
    openUrlMock,
    routerMock,
} = vi.hoisted(() => ({
    appUseMock: vi.fn(),
    appMountMock: vi.fn(),
    completeManagedLoginMock: vi.fn(),
    createAppMock: vi.fn(),
    eventServiceEmitMock: vi.fn(),
    getCurrentWindowMock: vi.fn(),
    initializeManagedProviderStateMock: vi.fn(),
    openSettingsWindowMock: vi.fn(),
    settingsInitializeMock: vi.fn(),
    appUpdateCheckNowMock: vi.fn(),
    isLlmMetadataEmptyMock: vi.fn(),
    getCurrentMock: vi.fn(),
    initializeFontLoaderMock: vi.fn(),
    initializeLoggerMock: vi.fn(),
    syncAllModelsMetadataMock: vi.fn(),
    updateModelMetadataMock: vi.fn(),
    onOpenUrlMock: vi.fn(),
    originalWindowOpenMock: vi.fn(),
    openUrlMock: vi.fn(),
    routerMock: {
        push: vi.fn(),
    },
}));

vi.mock('vue', () => ({
    createApp: createAppMock,
}));

vi.mock('pinia', () => ({
    createPinia: () => ({ name: 'pinia' }),
}));

vi.mock('@services/LoggerService', () => ({
    initializeLogger: initializeLoggerMock,
}));

vi.mock('@services/AppUpdateService', () => ({
    appUpdateService: {
        checkNow: appUpdateCheckNowMock,
    },
}));

vi.mock('@services/AuthService', () => ({
    completeManagedLogin: completeManagedLoginMock,
    initializeManagedProviderState: initializeManagedProviderStateMock,
}));

vi.mock('@database/queries', () => ({
    isLlmMetadataEmpty: isLlmMetadataEmptyMock,
    syncAllModelsMetadata: syncAllModelsMetadataMock,
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => ({
    updateModelMetadata: updateModelMetadataMock,
}));

vi.mock('@services/EventService', () => ({
    AppEvent: {
        SETTINGS_AI_SERVICES_FOCUS_PROVIDER: 'SETTINGS_AI_SERVICES_FOCUS_PROVIDER',
        AI_MODELS_UPDATED: 'AI_MODELS_UPDATED',
    },
    eventService: {
        emit: eventServiceEmitMock,
    },
}));

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            openSettingsWindow: openSettingsWindowMock,
        },
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: getCurrentWindowMock,
}));

vi.mock('@tauri-apps/plugin-deep-link', () => ({
    getCurrent: getCurrentMock,
    onOpenUrl: onOpenUrlMock,
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: openUrlMock,
}));

vi.mock('@/utils/font', () => ({
    initializeFontLoader: initializeFontLoaderMock,
}));

vi.mock('@/i18n', () => ({
    installI18n: vi.fn(),
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => ({
        initialize: settingsInitializeMock,
    }),
}));

vi.mock('@/App.vue', () => ({
    default: {
        name: 'App',
    },
}));

vi.mock('@/router', () => ({
    default: routerMock,
}));

describe('app bootstrap i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        document.body.innerHTML = '<div id="app"></div>';
        Object.defineProperty(window, 'open', {
            value: originalWindowOpenMock,
            writable: true,
            configurable: true,
        });

        appUseMock.mockReturnThis();
        appMountMock.mockReturnValue(undefined);
        createAppMock.mockReturnValue({
            use: appUseMock,
            mount: appMountMock,
        });
        originalWindowOpenMock.mockReturnValue({ name: 'window' });
        openUrlMock.mockResolvedValue(undefined);
        settingsInitializeMock.mockResolvedValue(undefined);
        appUpdateCheckNowMock.mockResolvedValue(false);
        completeManagedLoginMock.mockResolvedValue(false);
        initializeManagedProviderStateMock.mockResolvedValue(undefined);
        isLlmMetadataEmptyMock.mockResolvedValue(false);
        syncAllModelsMetadataMock.mockResolvedValue(undefined);
        updateModelMetadataMock.mockResolvedValue(undefined);
        openSettingsWindowMock.mockResolvedValue(undefined);
        eventServiceEmitMock.mockResolvedValue(undefined);
        getCurrentMock.mockResolvedValue([]);
        onOpenUrlMock.mockResolvedValue(undefined);
        getCurrentWindowMock.mockReturnValue({
            label: 'main',
        });
    });

    it('initializes persisted settings before mounting without starting the legacy DOM localizer', async () => {
        const { installI18n } = await import('@/i18n');

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(initializeLoggerMock).toHaveBeenCalledTimes(1);
        expect(initializeFontLoaderMock).toHaveBeenCalledTimes(1);
        expect(appUseMock).toHaveBeenCalledWith({ name: 'pinia' });
        expect(appUseMock).toHaveBeenCalledWith(routerMock);
        expect(installI18n).toHaveBeenCalledWith({
            use: appUseMock,
            mount: appMountMock,
        });
        expect(settingsInitializeMock).toHaveBeenCalledTimes(1);
        expect(appMountMock).toHaveBeenCalledWith('#app');
        const settingsInitializeOrder = settingsInitializeMock.mock.invocationCallOrder[0]!;
        expect(settingsInitializeOrder).toBeLessThan(appMountMock.mock.invocationCallOrder[0]!);
    });

    it('refreshes remote model metadata during bootstrap when local metadata is empty', async () => {
        isLlmMetadataEmptyMock.mockResolvedValue(true);

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(updateModelMetadataMock).toHaveBeenCalledTimes(1);
        expect(syncAllModelsMetadataMock).not.toHaveBeenCalled();
    });

    it('syncs cached model metadata during bootstrap without refreshing remote metadata', async () => {
        isLlmMetadataEmptyMock.mockResolvedValue(false);

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(updateModelMetadataMock).not.toHaveBeenCalled();
        expect(syncAllModelsMetadataMock).toHaveBeenCalledTimes(1);
    });

    it('continues bootstrap when remote model metadata refresh fails', async () => {
        const metadataError = new Error('metadata unavailable');
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        isLlmMetadataEmptyMock.mockResolvedValue(true);
        updateModelMetadataMock.mockRejectedValue(metadataError);

        const { initializeApp } = await import('@/bootstrap');
        await expect(initializeApp()).resolves.toBeUndefined();

        expect(appMountMock).toHaveBeenCalledWith('#app');
        expect(consoleSpy).toHaveBeenCalledWith(
            '[Bootstrap] Failed to initialize model metadata:',
            metadataError
        );
        consoleSpy.mockRestore();
    });

    it('mounts without the legacy DOM localizer when persisted settings fail to initialize', async () => {
        const settingsError = new Error('settings unavailable');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        settingsInitializeMock.mockRejectedValue(settingsError);

        const { initializeApp } = await import('@/bootstrap');
        await expect(initializeApp()).resolves.toBeUndefined();

        expect(settingsInitializeMock).toHaveBeenCalledTimes(1);
        expect(appMountMock).toHaveBeenCalledWith('#app');
        expect(consoleSpy).toHaveBeenCalledWith(
            'Failed to initialize persisted settings during bootstrap.',
            settingsError
        );
        consoleSpy.mockRestore();
    });

    it('uses the same explicit vue-i18n bootstrap for popup routes', async () => {
        window.history.replaceState(null, '', '/popup?type=session-history-popup');

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(settingsInitializeMock).toHaveBeenCalledTimes(1);
        expect(appMountMock).toHaveBeenCalledWith('#app');
    });

    it('consumes pending deep links during bootstrap and broadcasts model refresh after login', async () => {
        getCurrentMock.mockResolvedValue(['touchai://hub/auth/callback?code=boot-code']);
        completeManagedLoginMock.mockResolvedValue(true);

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(getCurrentMock).toHaveBeenCalledTimes(1);
        expect(completeManagedLoginMock).toHaveBeenCalledWith(
            'touchai://hub/auth/callback?code=boot-code'
        );
        expect(openSettingsWindowMock).toHaveBeenCalledTimes(1);
        expect(eventServiceEmitMock).toHaveBeenCalledWith(
            'SETTINGS_AI_SERVICES_FOCUS_PROVIDER',
            expect.objectContaining({
                section: 'ai-services',
                providerDriver: 'mimo',
                mode: 'managed',
                reason: 'managed-auth-callback',
            })
        );
        expect(eventServiceEmitMock).toHaveBeenCalledWith('AI_MODELS_UPDATED', {
            updatedAt: expect.any(Number),
        });
    });

    it('registers a deep-link listener that completes managed login callbacks', async () => {
        let registeredHandler: ((urls: string[]) => Promise<void>) | undefined;
        onOpenUrlMock.mockImplementation(async (handler) => {
            registeredHandler = handler;
        });
        completeManagedLoginMock.mockResolvedValue(true);

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(onOpenUrlMock).toHaveBeenCalledTimes(1);
        await registeredHandler?.(['touchai://hub/auth/callback?code=live-code']);

        expect(completeManagedLoginMock).toHaveBeenCalledWith(
            'touchai://hub/auth/callback?code=live-code'
        );
        expect(openSettingsWindowMock).toHaveBeenCalledTimes(1);
        expect(eventServiceEmitMock).toHaveBeenCalledWith(
            'SETTINGS_AI_SERVICES_FOCUS_PROVIDER',
            expect.objectContaining({
                section: 'ai-services',
                providerDriver: 'mimo',
                mode: 'managed',
                reason: 'managed-auth-callback',
            })
        );
        expect(eventServiceEmitMock).toHaveBeenCalledWith('AI_MODELS_UPDATED', {
            updatedAt: expect.any(Number),
        });
    });

    it('skips managed deep-link bootstrap in popup windows', async () => {
        getCurrentWindowMock.mockReturnValue({
            label: 'popup-session-history-popup',
        });

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(getCurrentMock).not.toHaveBeenCalled();
        expect(onOpenUrlMock).not.toHaveBeenCalled();
        expect(completeManagedLoginMock).not.toHaveBeenCalled();
    });

    it('skips managed deep-link bootstrap outside the main window', async () => {
        getCurrentWindowMock.mockReturnValue({
            label: 'settings',
        });

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(getCurrentMock).not.toHaveBeenCalled();
        expect(onOpenUrlMock).not.toHaveBeenCalled();
        expect(completeManagedLoginMock).not.toHaveBeenCalled();
    });

    it('routes app-relative anchor clicks through the Vue router', async () => {
        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();
        routerMock.push.mockClear();

        const anchor = document.createElement('a');
        anchor.href = '/settings';
        anchor.textContent = 'Settings';
        document.body.append(anchor);

        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        const dispatched = anchor.dispatchEvent(event);

        expect(dispatched).toBe(false);
        expect(routerMock.push).toHaveBeenCalledWith('/settings');
        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it('opens external anchor clicks with the Tauri opener', async () => {
        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();
        openUrlMock.mockClear();

        const anchor = document.createElement('a');
        anchor.href = 'https://example.com/docs';
        const child = document.createElement('span');
        anchor.append(child);
        document.body.append(anchor);

        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        const dispatched = child.dispatchEvent(event);

        expect(dispatched).toBe(false);
        expect(openUrlMock).toHaveBeenCalledWith('https://example.com/docs');
    });

    it('ignores clicks without actionable hrefs', async () => {
        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();
        openUrlMock.mockClear();
        routerMock.push.mockClear();

        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const anchor = document.createElement('a');
        document.body.append(anchor);
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(openUrlMock).not.toHaveBeenCalled();
        expect(routerMock.push).not.toHaveBeenCalled();
    });

    it('intercepts window.open for external links while preserving internal links', async () => {
        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(window.open('https://example.com/docs', '_blank')).toBeNull();
        expect(openUrlMock).toHaveBeenCalledWith('https://example.com/docs');

        openUrlMock.mockClear();
        expect(window.open('/settings', '_self', 'noopener')).toEqual({ name: 'window' });
        expect(originalWindowOpenMock).toHaveBeenCalledWith('/settings', '_self', 'noopener');
        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it('treats Tauri and asset links as internal window targets', async () => {
        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(window.open('tauri://localhost/settings')).toEqual({ name: 'window' });
        expect(window.open('asset://localhost/icon.png')).toEqual({ name: 'window' });
        expect(originalWindowOpenMock).toHaveBeenCalledWith(
            'tauri://localhost/settings',
            undefined,
            undefined
        );
        expect(originalWindowOpenMock).toHaveBeenCalledWith(
            'asset://localhost/icon.png',
            undefined,
            undefined
        );
    });

    it('opens malformed absolute URLs externally instead of crashing', async () => {
        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(window.open('http://[bad')).toBeNull();

        expect(openUrlMock).toHaveBeenCalledWith('http://[bad');
    });
});
