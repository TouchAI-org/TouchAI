import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    eventHandlers,
    eventEmitMock,
    eventOnMock,
    getCurrentWindowMock,
    hidePopupWindowMock,
    initializeBuiltInPopupsMock,
    requestResizeMock,
    resetMeasuredHeightMock,
    settingsInitializeMock,
} = vi.hoisted(() => ({
    eventHandlers: new Map<string, (payload: unknown) => unknown>(),
    eventEmitMock: vi.fn(),
    eventOnMock: vi.fn(),
    getCurrentWindowMock: vi.fn(),
    hidePopupWindowMock: vi.fn(),
    initializeBuiltInPopupsMock: vi.fn(),
    requestResizeMock: vi.fn(),
    resetMeasuredHeightMock: vi.fn(),
    settingsInitializeMock: vi.fn(),
}));

vi.mock('@composables/useWindowResize', () => ({
    useWindowResize: () => ({
        requestResize: requestResizeMock,
        resetMeasuredHeight: resetMeasuredHeightMock,
    }),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: {
        POPUP_CLOSED: 'popup-closed',
        POPUP_DATA: 'popup-data',
        POPUP_KEYDOWN: 'popup-keydown',
        POPUP_READY: 'popup-ready',
        SEARCH_SURFACE_COMMAND: 'search-surface-command',
    },
    eventService: {
        emit: eventEmitMock,
        on: eventOnMock,
    },
}));

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            hidePopupWindow: hidePopupWindowMock,
        },
    },
}));

vi.mock('@services/PopupService', () => ({
    initializeBuiltInPopups: initializeBuiltInPopupsMock,
    popupRegistry: {
        get: vi.fn(() => null),
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: getCurrentWindowMock,
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => ({
        initialize: settingsInitializeMock,
    }),
}));

describe('PopupView i18n bootstrap', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        eventHandlers.clear();
        window.history.replaceState(null, '', '/popup?type=session-history');
        eventOnMock.mockImplementation(
            async (event: string, handler: (payload: unknown) => void) => {
                eventHandlers.set(event, handler);
                return vi.fn();
            }
        );
        eventEmitMock.mockResolvedValue(undefined);
        hidePopupWindowMock.mockResolvedValue(undefined);
        getCurrentWindowMock.mockReturnValue({
            hide: vi.fn().mockResolvedValue(undefined),
            label: 'popup-session-history-popup',
            setFocus: vi.fn(),
            show: vi.fn().mockResolvedValue(undefined),
        });
        settingsInitializeMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('announces popup readiness when persisted settings initialization fails', async () => {
        const { default: PopupView } = await import('@/views/PopupView/index.vue');
        settingsInitializeMock.mockRejectedValueOnce(new Error('settings unavailable'));

        mount(PopupView);
        await flushPromises();

        expect(settingsInitializeMock).toHaveBeenCalledTimes(1);
        expect(eventOnMock).toHaveBeenCalledWith('popup-data', expect.any(Function));
        expect(eventOnMock).toHaveBeenCalledWith('popup-closed', expect.any(Function));
        expect(eventOnMock).toHaveBeenCalledWith('popup-keydown', expect.any(Function));
        expect(eventEmitMock).toHaveBeenCalledWith('popup-ready', {
            windowLabel: 'popup-session-history-popup',
        });
    });

    it('does not wait for persisted settings before announcing popup readiness', async () => {
        const { default: PopupView } = await import('@/views/PopupView/index.vue');
        settingsInitializeMock.mockReturnValueOnce(new Promise(() => undefined));

        mount(PopupView);
        await flushPromises();

        expect(settingsInitializeMock).toHaveBeenCalledTimes(1);
        expect(eventEmitMock).toHaveBeenCalledWith('popup-ready', {
            windowLabel: 'popup-session-history-popup',
        });
    });

    it('hides an empty popup window if no popup data arrives after ready', async () => {
        vi.useFakeTimers();
        const hideMock = vi.fn().mockResolvedValue(undefined);
        getCurrentWindowMock.mockReturnValue({
            hide: hideMock,
            label: 'popup-session-history-popup',
            setFocus: vi.fn(),
        });
        const { default: PopupView } = await import('@/views/PopupView/index.vue');

        mount(PopupView);
        await flushPromises();
        await vi.advanceTimersByTimeAsync(151);

        expect(hideMock).toHaveBeenCalledTimes(1);
    });

    it('closes the current popup from a matching native search surface command', async () => {
        const { default: PopupView } = await import('@/views/PopupView/index.vue');

        mount(PopupView);
        await flushPromises();

        await eventHandlers.get('popup-data')?.({
            popupId: 'popup-session-history-popup:1',
            windowLabel: 'popup-session-history-popup',
            popupSessionVersion: 1,
            type: 'session-history-popup',
            isShow: true,
            data: {
                sessions: [],
                activeSessionId: null,
                searchQuery: '',
                isLoading: false,
                toggleShortcut: 'Alt+Space',
            },
        });
        await flushPromises();

        eventHandlers.get('search-surface-command')?.({
            actionId: 'search.model.toggle',
            shortcut: 'Alt+Space',
            source: 'webview2-accelerator',
        });
        await flushPromises();
        expect(hidePopupWindowMock).not.toHaveBeenCalled();

        eventHandlers.get('search-surface-command')?.({
            actionId: 'search.history.open',
            shortcut: 'Mod+H',
            source: 'webview2-accelerator',
        });
        await flushPromises();
        expect(hidePopupWindowMock).not.toHaveBeenCalled();

        eventHandlers.get('search-surface-command')?.({
            actionId: 'search.history.open',
            shortcut: 'Alt+Space',
            source: 'webview2-accelerator',
        });
        await flushPromises();

        expect(hidePopupWindowMock).toHaveBeenCalledWith({
            popupId: 'popup-session-history-popup:1',
            windowLabel: 'popup-session-history-popup',
            popupSessionVersion: 1,
        });
    });
});
