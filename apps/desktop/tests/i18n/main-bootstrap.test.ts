import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    appUseMock,
    appMountMock,
    createAppMock,
    settingsInitializeMock,
    appUpdateCheckNowMock,
    initializeFontLoaderMock,
    initializeLoggerMock,
    originalWindowOpenMock,
    openUrlMock,
    routerMock,
} = vi.hoisted(() => ({
    appUseMock: vi.fn(),
    appMountMock: vi.fn(),
    createAppMock: vi.fn(),
    settingsInitializeMock: vi.fn(),
    appUpdateCheckNowMock: vi.fn(),
    initializeFontLoaderMock: vi.fn(),
    initializeLoggerMock: vi.fn(),
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
        expect(originalWindowOpenMock).toHaveBeenCalledWith(
            '/settings',
            '_self',
            'noopener'
        );
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
