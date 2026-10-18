import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    appUseMock,
    appMountMock,
    createAppMock,
    getCurrentWindowMock,
    settingsInitializeMock,
    appUpdateCheckNowMock,
    initializeAppUpdateNotificationsMock,
    builtInToolSyncMock,
    prewarmBashMock,
    isLlmMetadataAliasEmptyMock,
    isLlmMetadataEmptyMock,
    initializeFontLoaderMock,
    seedModelMetadataFromSnapshotMock,
    initializeLoggerMock,
    syncAllModelsMetadataMock,
    refreshModelMetadataIfStaleMock,
    originalWindowOpenMock,
    openUrlMock,
    routerMock,
} = vi.hoisted(() => ({
    appUseMock: vi.fn(),
    appMountMock: vi.fn(),
    createAppMock: vi.fn(),
    getCurrentWindowMock: vi.fn(),
    settingsInitializeMock: vi.fn(),
    appUpdateCheckNowMock: vi.fn(),
    initializeAppUpdateNotificationsMock: vi.fn(),
    builtInToolSyncMock: vi.fn(),
    prewarmBashMock: vi.fn(),
    isLlmMetadataAliasEmptyMock: vi.fn(),
    isLlmMetadataEmptyMock: vi.fn(),
    initializeFontLoaderMock: vi.fn(),
    seedModelMetadataFromSnapshotMock: vi.fn(),
    initializeLoggerMock: vi.fn(),
    syncAllModelsMetadataMock: vi.fn(),
    refreshModelMetadataIfStaleMock: vi.fn(),
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

vi.mock('@services/AppUpdateService/notifications', () => ({
    initializeAppUpdateNotifications: initializeAppUpdateNotificationsMock,
}));

vi.mock('@database/queries', () => ({
    isLlmMetadataAliasEmpty: isLlmMetadataAliasEmptyMock,
    isLlmMetadataEmpty: isLlmMetadataEmptyMock,
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => ({
    refreshModelMetadataIfStale: refreshModelMetadataIfStaleMock,
    seedModelMetadataFromSnapshot: seedModelMetadataFromSnapshotMock,
    syncAllModelsMetadata: syncAllModelsMetadataMock,
}));

vi.mock('@/services/BuiltInToolService/service', () => ({
    builtInToolService: {
        syncRegisteredTools: builtInToolSyncMock,
    },
}));

vi.mock('@/services/BuiltInToolService/tools/bash/helper', () => ({
    prewarmBashToolRuntime: prewarmBashMock,
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: getCurrentWindowMock,
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
        window.history.replaceState(null, '', '/');
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
        initializeAppUpdateNotificationsMock.mockResolvedValue(undefined);
        builtInToolSyncMock.mockResolvedValue(undefined);
        prewarmBashMock.mockResolvedValue(undefined);
        isLlmMetadataAliasEmptyMock.mockResolvedValue(false);
        isLlmMetadataEmptyMock.mockResolvedValue(false);
        syncAllModelsMetadataMock.mockResolvedValue(undefined);
        seedModelMetadataFromSnapshotMock.mockResolvedValue(undefined);
        refreshModelMetadataIfStaleMock.mockResolvedValue({ status: 'unchanged' });
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
        expect(builtInToolSyncMock).toHaveBeenCalledTimes(1);
        expect(appUseMock).toHaveBeenCalledWith({ name: 'pinia' });
        expect(appUseMock).toHaveBeenCalledWith(routerMock);
        expect(installI18n).toHaveBeenCalledWith({
            use: appUseMock,
            mount: appMountMock,
        });
        expect(settingsInitializeMock).toHaveBeenCalledTimes(1);
        expect(appMountMock).toHaveBeenCalledWith('#app');
        expect(initializeAppUpdateNotificationsMock).toHaveBeenCalledTimes(1);
        const settingsInitializeOrder = settingsInitializeMock.mock.invocationCallOrder[0]!;
        expect(settingsInitializeOrder).toBeLessThan(appMountMock.mock.invocationCallOrder[0]!);
    });

    it('sleeps until 08:00 before starting hourly automatic checks', async () => {
        const nowSpy = vi
            .spyOn(Date, 'now')
            .mockReturnValue(new Date(2026, 9, 18, 7, 30).getTime());
        const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(vi.fn());
        try {
            const { initializeApp } = await import('@/bootstrap');
            await initializeApp();
            for (let index = 0; index < 12; index += 1) await Promise.resolve();

            expect(appUpdateCheckNowMock).not.toHaveBeenCalled();
            const timer = timeoutSpy.mock.calls.find(([, delay]) => delay === 30 * 60 * 1000)?.[0];
            expect(timer).toBeTypeOf('function');
            nowSpy.mockReturnValue(new Date(2026, 9, 18, 8).getTime());
            timeoutSpy.mockClear();
            (timer as () => void)();

            expect(appUpdateCheckNowMock).toHaveBeenCalledWith('automatic');
            expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);

            appUpdateCheckNowMock.mockClear();
            timeoutSpy.mockClear();
            nowSpy.mockReturnValue(new Date(2026, 9, 19, 0).getTime());
            (timer as () => void)();

            expect(appUpdateCheckNowMock).not.toHaveBeenCalled();
            expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 8 * 60 * 60 * 1000);
        } finally {
            nowSpy.mockRestore();
            timeoutSpy.mockRestore();
        }
    });

    it('seeds bundled metadata during bootstrap when local metadata is empty', async () => {
        isLlmMetadataEmptyMock.mockResolvedValue(true);

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(seedModelMetadataFromSnapshotMock).toHaveBeenCalledTimes(1);
        expect(syncAllModelsMetadataMock).not.toHaveBeenCalled();
    });

    it('checks the remote catalog after mount without blocking startup', async () => {
        isLlmMetadataEmptyMock.mockResolvedValue(false);
        isLlmMetadataAliasEmptyMock.mockResolvedValue(false);

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(appMountMock).toHaveBeenCalledWith('#app');
        await vi.waitFor(() => {
            expect(refreshModelMetadataIfStaleMock).toHaveBeenCalledTimes(1);
        });

        const refreshOrder = refreshModelMetadataIfStaleMock.mock.invocationCallOrder[0]!;
        expect(refreshOrder).toBeGreaterThan(appMountMock.mock.invocationCallOrder[0]!);
    });

    it('syncs cached model metadata during bootstrap', async () => {
        isLlmMetadataEmptyMock.mockResolvedValue(false);
        isLlmMetadataAliasEmptyMock.mockResolvedValue(false);

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(syncAllModelsMetadataMock).toHaveBeenCalledTimes(1);
    });

    it('reseeds metadata when the cached catalog has no aliases yet', async () => {
        isLlmMetadataEmptyMock.mockResolvedValue(false);
        isLlmMetadataAliasEmptyMock.mockResolvedValue(true);

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(seedModelMetadataFromSnapshotMock).toHaveBeenCalledTimes(1);
        expect(syncAllModelsMetadataMock).not.toHaveBeenCalled();
    });

    it('continues bootstrap when seeding the bundled snapshot fails', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        isLlmMetadataEmptyMock.mockResolvedValue(true);
        seedModelMetadataFromSnapshotMock.mockRejectedValue(new Error('snapshot unavailable'));

        const { initializeApp } = await import('@/bootstrap');
        await expect(initializeApp()).resolves.toBeUndefined();

        expect(appMountMock).toHaveBeenCalledWith('#app');
        expect(consoleSpy).toHaveBeenCalledWith(
            '[Bootstrap] Failed to seed bundled model metadata:',
            expect.any(Error)
        );
        consoleSpy.mockRestore();
    });

    it('keeps running when the remote metadata check fails', async () => {
        const metadataError = new Error('metadata unavailable');
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        isLlmMetadataEmptyMock.mockResolvedValue(false);
        isLlmMetadataAliasEmptyMock.mockResolvedValue(false);
        refreshModelMetadataIfStaleMock.mockRejectedValue(metadataError);

        const { initializeApp } = await import('@/bootstrap');
        await expect(initializeApp()).resolves.toBeUndefined();

        await vi.waitFor(() => {
            expect(consoleSpy).toHaveBeenCalledWith(
                '[Bootstrap] Failed to refresh model metadata:',
                metadataError
            );
        });
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

    it('uses lightweight bootstrap for popup routes', async () => {
        window.history.replaceState(null, '', '/#/popup?type=session-history-popup');

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(appMountMock).toHaveBeenCalledWith('#app');
        expect(initializeFontLoaderMock).not.toHaveBeenCalled();
        expect(builtInToolSyncMock).not.toHaveBeenCalled();
        expect(isLlmMetadataEmptyMock).not.toHaveBeenCalled();
        expect(syncAllModelsMetadataMock).not.toHaveBeenCalled();
        expect(refreshModelMetadataIfStaleMock).not.toHaveBeenCalled();
        expect(settingsInitializeMock).not.toHaveBeenCalled();
        expect(appUpdateCheckNowMock).not.toHaveBeenCalled();
        expect(initializeAppUpdateNotificationsMock).not.toHaveBeenCalled();
    });

    it('uses lightweight bootstrap for the tray menu window', async () => {
        getCurrentWindowMock.mockReturnValue({
            label: 'tray-menu',
        });

        const { initializeApp } = await import('@/bootstrap');
        await initializeApp();

        expect(appMountMock).toHaveBeenCalledWith('#app');
        expect(initializeFontLoaderMock).not.toHaveBeenCalled();
        expect(isLlmMetadataEmptyMock).not.toHaveBeenCalled();
        expect(syncAllModelsMetadataMock).not.toHaveBeenCalled();
        expect(refreshModelMetadataIfStaleMock).not.toHaveBeenCalled();
        expect(settingsInitializeMock).not.toHaveBeenCalled();
        expect(appUpdateCheckNowMock).not.toHaveBeenCalled();
        expect(initializeAppUpdateNotificationsMock).not.toHaveBeenCalled();
    });

    it.each(['window-label', 'route'])(
        'opens settings via %s without waiting for primary-window runtime initialization',
        async (entry) => {
            if (entry === 'window-label') {
                getCurrentWindowMock.mockReturnValue({ label: 'settings' });
            } else {
                window.history.replaceState(null, '', '/#/settings');
            }
            let resolveRuntime!: () => void;
            const runtimeReady = new Promise<void>((resolve) => {
                resolveRuntime = resolve;
            });
            builtInToolSyncMock.mockReturnValue(runtimeReady);
            prewarmBashMock.mockReturnValue(runtimeReady);
            const { initializeApp } = await import('@/bootstrap');
            const startup = initializeApp();
            for (let index = 0; index < 12; index += 1) await Promise.resolve();

            try {
                expect(appMountMock).toHaveBeenCalledWith('#app');
                expect(settingsInitializeMock).toHaveBeenCalledTimes(1);
                expect(initializeFontLoaderMock).toHaveBeenCalledTimes(1);
                expect(builtInToolSyncMock).not.toHaveBeenCalled();
                expect(prewarmBashMock).not.toHaveBeenCalled();
                expect(isLlmMetadataEmptyMock).not.toHaveBeenCalled();
                expect(syncAllModelsMetadataMock).not.toHaveBeenCalled();
                expect(refreshModelMetadataIfStaleMock).not.toHaveBeenCalled();
                expect(initializeAppUpdateNotificationsMock).not.toHaveBeenCalled();
                expect(appUpdateCheckNowMock).not.toHaveBeenCalled();
                expect(settingsInitializeMock.mock.invocationCallOrder[0]).toBeLessThan(
                    appMountMock.mock.invocationCallOrder[0]!
                );
            } finally {
                resolveRuntime();
                await startup;
            }
        }
    );

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
