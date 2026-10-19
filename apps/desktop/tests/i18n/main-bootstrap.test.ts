// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

/**
 * Startup behavior.
 *
 * What a user observes from the boot path: a window that renders, popup and
 * tray windows that start without the main-window warm-up, links that stay in
 * the app, and background work whose failure never blocks the window.
 *
 * The router and the i18n runtime are real; the router uses in-memory history
 * and stub screens so a click proves navigation happened without loading the
 * real settings screens.
 */
import { appUpdateService } from '@services/AppUpdateService';
import { initializeAppUpdateNotifications } from '@services/AppUpdateService/notifications';
import { log } from '@services/ObservabilityService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { useRoute } from 'vue-router';

import { initializeApp } from '@/bootstrap';
import router from '@/router';
import { initializeFontLoader } from '@/utils/font';

const settingsStoreMock = vi.hoisted(() => ({
    initialize: vi.fn(),
    usageDetailRetentionDays: 0,
}));

const metadataMock = vi.hoisted(() => ({
    refreshModelMetadataIfStale: vi.fn(),
    syncAllModelsMetadata: vi.fn(),
}));

// 内置快照种子有独立入口（1.6MB 快照只在空库兜底时解析）。
const metadataSeedMock = vi.hoisted(() => ({
    seedModelMetadataFromSnapshot: vi.fn(),
}));

const toolServiceMock = vi.hoisted(() => ({
    syncRegisteredTools: vi.fn(),
}));

const prewarmBashMock = vi.hoisted(() => vi.fn());

const llmMetadataMock = vi.hoisted(() => ({
    isLlmMetadataAliasEmpty: vi.fn(),
    isLlmMetadataEmpty: vi.fn(),
}));

vi.mock('@/App.vue', () => ({
    default: defineComponent({
        name: 'AppStub',
        setup() {
            const route = useRoute();
            return () => h('div', { 'data-testid': 'app-root' }, `route:${route.path}`);
        },
    }),
}));

vi.mock('@/router', async () => {
    const { createMemoryHistory, createRouter } = await import('vue-router');
    const screen = defineComponent({ name: 'ScreenStub', render: () => h('div') });
    const memoryRouter = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/', component: screen },
            { path: '/settings', component: screen },
            { path: '/tray-menu', component: screen },
            { path: '/popup', component: screen },
        ],
    });
    return { default: memoryRouter };
});

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsStoreMock,
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => metadataMock);

vi.mock('@/services/AgentService/infrastructure/modelMetadata/seed', () => metadataSeedMock);

vi.mock('@/services/BuiltInToolService/service', () => ({
    builtInToolService: toolServiceMock,
}));

vi.mock('@/services/BuiltInToolService/tools/bash/helper', () => ({
    prewarmBashToolRuntime: prewarmBashMock,
}));

vi.mock('@services/UsageService/maintenance', () => ({
    runUsageMaintenance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@database/queries', () => llmMetadataMock);

vi.mock('@services/AppUpdateService', () => ({
    appUpdateService: { checkNow: vi.fn() },
}));

vi.mock('@services/AppUpdateService/notifications', () => ({
    initializeAppUpdateNotifications: vi.fn(),
}));

vi.mock('@services/ObservabilityService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@services/ObservabilityService')>()),
    initObservability: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
    openUrl: vi.fn(),
}));

vi.mock('@/utils/font', () => ({
    initializeFontLoader: vi.fn(),
}));

function stubRoot(): void {
    const root = document.createElement('div');
    root.id = 'app';
    document.body.append(root);
}

function mainWindowAt(hash = '/'): void {
    stubRoot();
    window.history.replaceState(null, '', hash);
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'main' } as never);
}

/** Start the app and hand back what the user sees: the mounted root element. */
async function startApp(): Promise<HTMLElement> {
    await initializeApp();
    const root = document.querySelector<HTMLElement>('[data-testid="app-root"]');
    if (!root) throw new Error('app root did not mount');
    return root;
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    vi.mocked(getCurrentWindow).mockReturnValue({ label: 'main' } as never);
    vi.mocked(openUrl).mockResolvedValue(undefined);
    vi.mocked(initializeAppUpdateNotifications).mockResolvedValue(undefined);
    vi.mocked(appUpdateService.checkNow).mockResolvedValue(false);
    vi.mocked(toolServiceMock.syncRegisteredTools).mockResolvedValue(undefined);
    vi.mocked(prewarmBashMock).mockResolvedValue(undefined);
    vi.mocked(llmMetadataMock.isLlmMetadataEmpty).mockResolvedValue(false);
    vi.mocked(llmMetadataMock.isLlmMetadataAliasEmpty).mockResolvedValue(false);
    vi.mocked(metadataMock.syncAllModelsMetadata).mockResolvedValue(undefined);
    vi.mocked(metadataSeedMock.seedModelMetadataFromSnapshot).mockResolvedValue(undefined);
    vi.mocked(metadataMock.refreshModelMetadataIfStale).mockResolvedValue({ status: 'unchanged' });
    settingsStoreMock.initialize.mockResolvedValue(undefined);
});

describe('user opens the main window', () => {
    it('user sees the app rendered with routing and translations installed', async () => {
        mainWindowAt();

        const root = await startApp();

        expect(root.textContent).toBe('route:/');
    });

    it('user never sees default settings because saved ones load before the window renders', async () => {
        mainWindowAt();
        let rootVisibleWhileLoading: boolean | null = null;
        let finishLoading!: () => void;
        settingsStoreMock.initialize.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    rootVisibleWhileLoading =
                        document.querySelector('[data-testid="app-root"]') !== null;
                    finishLoading = resolve;
                })
        );

        const startup = initializeApp();
        await vi.waitFor(() => expect(settingsStoreMock.initialize).toHaveBeenCalled());

        expect(rootVisibleWhileLoading).toBe(false);

        finishLoading();
        await startup;
        expect(document.querySelector('[data-testid="app-root"]')).not.toBeNull();
    });

    it('user gets the window before the background warm-up finishes', async () => {
        mainWindowAt();
        let finishTools!: () => void;
        toolServiceMock.syncRegisteredTools.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finishTools = resolve;
                })
        );

        // 后台能力未完成时窗口也必须已挂载：首帧不被工具补种阻塞。
        await initializeApp();
        expect(document.querySelector('[data-testid="app-root"]')).not.toBeNull();

        finishTools();
        await vi.waitFor(() => expect(toolServiceMock.syncRegisteredTools).toHaveBeenCalled());
    });

    it('user still gets a usable window when the saved settings cannot be loaded', async () => {
        mainWindowAt();
        const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
        settingsStoreMock.initialize.mockRejectedValue(new Error('settings unavailable'));

        await expect(initializeApp()).resolves.toBeUndefined();

        expect(document.querySelector('[data-testid="app-root"]')).not.toBeNull();
        errorSpy.mockRestore();
    });

    it('user gets the serif font prepared for the main window', async () => {
        mainWindowAt();

        await startApp();

        expect(initializeFontLoader).toHaveBeenCalledTimes(1);
    });

    it('user still gets a window when the built-in tool warm-up fails', async () => {
        mainWindowAt();
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        toolServiceMock.syncRegisteredTools.mockRejectedValue(new Error('tool sync failed'));

        await expect(initializeApp()).resolves.toBeUndefined();

        expect(document.querySelector('[data-testid="app-root"]')).not.toBeNull();
        warn.mockRestore();
    });
});

describe('user opens a popup or the tray menu', () => {
    it.each([
        [
            'a popup route',
            () => {
                stubRoot();
                window.history.replaceState(null, '', '/#/popup?type=session-history-popup');
            },
        ],
        [
            'the tray menu window',
            () => {
                stubRoot();
                window.history.replaceState(null, '', '/');
                vi.mocked(getCurrentWindow).mockReturnValue({ label: 'tray-menu' } as never);
            },
        ],
    ])('user gets a fast window with no font or tool warm-up on %s', async (_name, arrange) => {
        arrange();

        await startApp();

        expect(initializeFontLoader).not.toHaveBeenCalled();
        expect(toolServiceMock.syncRegisteredTools).not.toHaveBeenCalled();
        expect(metadataMock.syncAllModelsMetadata).not.toHaveBeenCalled();
        expect(initializeAppUpdateNotifications).not.toHaveBeenCalled();
    });

    it('user sees the settings window without waiting for the main-window warm-up', async () => {
        stubRoot();
        window.history.replaceState(null, '', '/#/settings');
        let releaseWarmUp!: () => void;
        toolServiceMock.syncRegisteredTools.mockReturnValue(
            new Promise<void>((resolve) => {
                releaseWarmUp = resolve;
            })
        );

        try {
            const startup = initializeApp();

            await vi.waitFor(() =>
                expect(document.querySelector('[data-testid="app-root"]')).not.toBeNull()
            );
            expect(toolServiceMock.syncRegisteredTools).not.toHaveBeenCalled();
            releaseWarmUp();
            await startup;
        } finally {
            releaseWarmUp();
        }
    });
});

describe('user clicks a link inside the app', () => {
    function anchorClick(href: string): boolean {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.textContent = 'link';
        document.body.append(anchor);
        return anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    it('user stays in the app when clicking an app-relative link', async () => {
        mainWindowAt();
        await startApp();
        const push = vi.spyOn(router, 'push');

        expect(anchorClick('/settings')).toBe(false);

        expect(push).toHaveBeenCalledWith('/settings');
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('user sees an external link open in the system browser', async () => {
        mainWindowAt();
        await startApp();

        const anchor = document.createElement('a');
        anchor.href = 'https://example.com/docs';
        const child = document.createElement('span');
        anchor.append(child);
        document.body.append(anchor);

        const dispatched = child.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(dispatched).toBe(false);
        expect(openUrl).toHaveBeenCalledWith('https://example.com/docs');
    });

    it('user is not navigated by a click that is not a link', async () => {
        mainWindowAt();
        await startApp();
        const push = vi.spyOn(router, 'push');

        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(openUrl).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });
});

describe('user follows a link opened by app code', () => {
    const realOpen = window.open;

    /** The browser's own window.open, captured by the interceptor during startup. */
    async function startWithBrowserOpen(): Promise<ReturnType<typeof vi.fn>> {
        const browserOpen = vi.fn(() => ({ name: 'window' }) as unknown as Window);
        window.open = browserOpen as unknown as typeof window.open;
        mainWindowAt();
        await startApp();
        return browserOpen;
    }

    afterEach(() => {
        window.open = realOpen;
    });

    it('user keeps app links in the app and sends external links to the system browser', async () => {
        const browserOpen = await startWithBrowserOpen();

        expect(window.open('/settings', '_self', 'noopener')).toEqual({ name: 'window' });
        expect(window.open('https://example.com/docs', '_blank')).toBeNull();

        expect(browserOpen).toHaveBeenCalledWith('/settings', '_self', 'noopener');
        expect(openUrl).toHaveBeenCalledWith('https://example.com/docs');
    });

    it('user keeps Tauri and asset URLs inside the app window', async () => {
        const browserOpen = await startWithBrowserOpen();

        expect(window.open('tauri://localhost/settings')).toEqual({ name: 'window' });
        expect(window.open('asset://localhost/icon.png')).toEqual({ name: 'window' });

        expect(browserOpen).toHaveBeenCalledTimes(2);
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('user gets the malformed link handed to the system browser instead of a crash', async () => {
        await startWithBrowserOpen();

        expect(window.open('http://[bad')).toBeNull();
        expect(openUrl).toHaveBeenCalledWith('http://[bad');
    });
});

describe('user leaves the app running overnight', () => {
    it('user gets an automatic update check once the daily window opens', async () => {
        const nowSpy = vi
            .spyOn(Date, 'now')
            .mockReturnValue(new Date(2026, 9, 18, 7, 30).getTime());
        const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(vi.fn() as never);
        try {
            mainWindowAt();
            await startApp();
            for (let index = 0; index < 12; index += 1) await Promise.resolve();

            expect(appUpdateService.checkNow).not.toHaveBeenCalled();
            const timer = timeoutSpy.mock.calls.find(([, delay]) => delay === 30 * 60 * 1000)?.[0];
            expect(timer).toBeTypeOf('function');

            nowSpy.mockReturnValue(new Date(2026, 9, 18, 8).getTime());
            timeoutSpy.mockClear();
            await (timer as () => Promise<void>)();

            expect(appUpdateService.checkNow).toHaveBeenCalledWith('automatic');
            expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);

            // After midnight the window is closed again, so the next check waits for 08:00.
            vi.mocked(appUpdateService.checkNow).mockClear();
            timeoutSpy.mockClear();
            nowSpy.mockReturnValue(new Date(2026, 9, 19, 0).getTime());
            await (timer as () => Promise<void>)();

            expect(appUpdateService.checkNow).not.toHaveBeenCalled();
            expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 8 * 60 * 60 * 1000);
        } finally {
            nowSpy.mockRestore();
            timeoutSpy.mockRestore();
        }
    });

    it('user keeps a one-hour rhythm when a check takes minutes', async () => {
        const startedAt = new Date(2026, 9, 18, 10).getTime();
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
        const timeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(vi.fn() as never);
        let finishCheck!: (checked: boolean) => void;
        vi.mocked(appUpdateService.checkNow).mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                finishCheck = resolve;
            })
        );

        try {
            mainWindowAt();
            await startApp();
            for (let index = 0; index < 12; index += 1) await Promise.resolve();

            expect(appUpdateService.checkNow).toHaveBeenCalledOnce();
            expect(timeoutSpy).not.toHaveBeenCalled();

            nowSpy.mockReturnValue(startedAt + 2 * 60 * 1000);
            finishCheck(true);
            for (let index = 0; index < 12; index += 1) await Promise.resolve();

            expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
            const nextCheck = timeoutSpy.mock.calls[0]![0] as () => Promise<void>;
            nowSpy.mockReturnValue(startedAt + 62 * 60 * 1000);
            await nextCheck();
            expect(appUpdateService.checkNow).toHaveBeenCalledTimes(2);
        } finally {
            finishCheck(false);
            nowSpy.mockRestore();
            timeoutSpy.mockRestore();
        }
    });
});

describe('user starts the app for the first time', () => {
    it('user sees bundled model metadata seeded when the local catalog is empty', async () => {
        llmMetadataMock.isLlmMetadataEmpty.mockResolvedValue(true);
        mainWindowAt();

        await startApp();

        expect(metadataSeedMock.seedModelMetadataFromSnapshot).toHaveBeenCalledTimes(1);
        expect(metadataMock.syncAllModelsMetadata).not.toHaveBeenCalled();
    });

    it('user sees the cached catalog synchronized when the local catalog exists', async () => {
        mainWindowAt();

        await startApp();

        expect(metadataMock.syncAllModelsMetadata).toHaveBeenCalledTimes(1);
        expect(metadataSeedMock.seedModelMetadataFromSnapshot).not.toHaveBeenCalled();
    });

    it('user sees bundled metadata reseeded when the cached catalog has no aliases', async () => {
        llmMetadataMock.isLlmMetadataAliasEmpty.mockResolvedValue(true);
        mainWindowAt();

        await startApp();

        expect(metadataSeedMock.seedModelMetadataFromSnapshot).toHaveBeenCalledTimes(1);
        expect(metadataMock.syncAllModelsMetadata).not.toHaveBeenCalled();
    });

    it('user still gets a window when seeding bundled metadata fails', async () => {
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        llmMetadataMock.isLlmMetadataEmpty.mockResolvedValue(true);
        metadataSeedMock.seedModelMetadataFromSnapshot.mockRejectedValue(
            new Error('snapshot unavailable')
        );
        mainWindowAt();

        await expect(initializeApp()).resolves.toBeUndefined();

        expect(document.querySelector('[data-testid="app-root"]')).not.toBeNull();
        warn.mockRestore();
    });

    it('user still gets a window when the remote catalog check fails', async () => {
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        metadataMock.refreshModelMetadataIfStale.mockRejectedValue(
            new Error('metadata unavailable')
        );
        mainWindowAt();

        await startApp();

        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        warn.mockRestore();
    });

    it('user gets the remote catalog checked after the window is already usable', async () => {
        mainWindowAt();

        await startApp();

        await vi.waitFor(() =>
            expect(metadataMock.refreshModelMetadataIfStale).toHaveBeenCalledTimes(1)
        );
    });
});
