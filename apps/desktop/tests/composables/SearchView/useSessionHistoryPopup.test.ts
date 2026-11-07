import { popupManager, type SessionHistoryData } from '@services/PopupService';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionHistoryPopup } from '@/views/SearchView/composables/useSessionHistoryPopup';

const { popupManagerMock, popupManagerState } = vi.hoisted(() => ({
    popupManagerState: {
        isOpen: true,
        currentType: 'session-history-popup' as const,
        currentPopupId: 'popup-session-history-popup:1',
        currentWindowLabel: 'popup-session-history-popup',
        currentPopupSessionVersion: 1,
        isInitialized: true,
    },
    popupManagerMock: {
        show: vi.fn(),
        hide: vi.fn(),
        updateData: vi.fn(),
        listen: vi.fn(),
    },
}));

function createPopupData(overrides: Partial<SessionHistoryData> = {}): SessionHistoryData {
    return {
        sessions: [],
        activeSessionId: null,
        searchQuery: '',
        isLoading: false,
        ...overrides,
    };
}

vi.mock('@services/PopupService', () => ({
    popupManager: {
        ...popupManagerMock,
        state: popupManagerState,
    },
}));

describe('when the user opens the session history panel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.assign(popupManagerState, {
            isOpen: true,
            currentType: 'session-history-popup',
            currentPopupId: 'popup-session-history-popup:1',
            currentWindowLabel: 'popup-session-history-popup',
            currentPopupSessionVersion: 1,
            isInitialized: true,
        });
        vi.mocked(popupManager.show).mockResolvedValue('popup-session-history-popup:1');
        vi.mocked(popupManager.hide).mockResolvedValue(undefined);
        vi.mocked(popupManager.updateData).mockResolvedValue(undefined);
        vi.mocked(popupManager.listen).mockResolvedValue(() => undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the panel open and the page told which popup is live', async () => {
        const onPopupSessionStart = vi.fn();
        const onPopupSessionEnd = vi.fn();
        const anchor = document.createElement('button');

        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => anchor,
                getPopupData: () => createPopupData({ searchQuery: 'hello' }),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => undefined,
                onPopupSessionStart,
                onPopupSessionEnd,
            })
        );

        await mounted.result.open();

        expect(popupManager.show).toHaveBeenCalledWith(
            'session-history-popup',
            anchor,
            createPopupData({ searchQuery: 'hello' })
        );
        expect(mounted.result.isOpen.value).toBe(true);
        expect(onPopupSessionStart).toHaveBeenCalledWith({
            popupId: 'popup-session-history-popup:1',
            windowLabel: 'popup-session-history-popup',
            popupSessionVersion: 1,
        });
        expect(onPopupSessionEnd).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('panel gets a fresh snapshot right after it opens', async () => {
        const anchor = document.createElement('button');
        const snapshots: SessionHistoryData[] = [
            // 打开瞬间列表还在加载，初始快照是 loading；之后加载已完成。
            createPopupData({ searchQuery: '', isLoading: true }),
            createPopupData({ searchQuery: '', isLoading: false }),
        ];
        let call = 0;

        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => anchor,
                getPopupData: () => snapshots[Math.min(call++, snapshots.length - 1)]!,
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => undefined,
            })
        );

        await mounted.result.open();

        // 弹层就绪后必须再推一次数据，否则会卡在「正在搜索」。
        expect(popupManager.updateData).toHaveBeenCalledWith(snapshots[1]);

        mounted.unmount();
    });

    it('user gets no panel when it went stale before it finished opening', async () => {
        Object.assign(popupManagerState, {
            currentPopupId: 'popup-session-history-popup:2',
            currentPopupSessionVersion: 2,
        });
        const onPopupSessionStart = vi.fn();
        const onPopupSessionEnd = vi.fn();
        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData({ searchQuery: 'stale-open' }),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => undefined,
                onPopupSessionStart,
                onPopupSessionEnd,
            })
        );

        await mounted.result.open();

        expect(mounted.result.isOpen.value).toBe(false);
        expect(onPopupSessionStart).not.toHaveBeenCalled();
        expect(onPopupSessionEnd).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('user keeps the panel open when a stale popup reports that it closed', async () => {
        let onCloseListener:
            | ((payload: {
                  popupId: string;
                  popupSessionVersion: number;
                  windowLabel: string;
                  type: 'session-history-popup';
              }) => void)
            | undefined;
        vi.mocked(popupManager.listen).mockImplementation(async (handlers) => {
            onCloseListener = handlers.onClose as typeof onCloseListener;
            return () => undefined;
        });
        const onClose = vi.fn();
        const onPopupSessionEnd = vi.fn();
        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose,
                onPopupSessionEnd,
            })
        );

        await mounted.result.open();

        onCloseListener?.({
            popupId: 'popup-session-history-popup:999',
            popupSessionVersion: 999,
            windowLabel: 'popup-session-history-popup',
            type: 'session-history-popup',
        });

        expect(mounted.result.isOpen.value).toBe(true);
        expect(onClose).not.toHaveBeenCalled();

        onCloseListener?.({
            popupId: 'popup-session-history-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
            type: 'session-history-popup',
        });

        expect(mounted.result.isOpen.value).toBe(false);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onPopupSessionEnd).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('user gets the panel closed without the page being told when history is no longer active', async () => {
        let onCloseListener:
            | ((payload: {
                  popupId: string;
                  popupSessionVersion: number;
                  windowLabel: string;
                  type: 'session-history-popup';
              }) => void)
            | undefined;
        vi.mocked(popupManager.listen).mockImplementation(async (handlers) => {
            onCloseListener = handlers.onClose as typeof onCloseListener;
            return () => undefined;
        });
        const onClose = vi.fn();
        const onPopupSessionEnd = vi.fn();
        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isSessionHistoryActive: () => false,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose,
                onPopupSessionEnd,
            })
        );

        await mounted.result.open();

        onCloseListener?.({
            popupId: 'popup-session-history-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
            type: 'session-history-popup',
        });

        expect(mounted.result.isOpen.value).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(onPopupSessionEnd).toHaveBeenCalledTimes(1);

        mounted.unmount();
    });

    it('user does not get a leftover popup window after leaving the search view', async () => {
        const onPopupSessionEnd = vi.fn();
        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => undefined,
                onPopupSessionEnd,
            })
        );

        await mounted.result.open();
        mounted.unmount();

        expect(popupManager.hide).toHaveBeenCalledTimes(1);
        expect(onPopupSessionEnd).toHaveBeenCalled();
    });

    it('user does not get a leaked popup listener when leaving before it finished registering', async () => {
        let resolveListen: ((cleanup: () => void) => void) | undefined;
        const lateCleanup = vi.fn();
        vi.mocked(popupManager.listen).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveListen = resolve;
                })
        );

        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => undefined,
            })
        );

        mounted.unmount();
        resolveListen?.(lateCleanup);
        await Promise.resolve();
        await Promise.resolve();

        expect(lateCleanup).toHaveBeenCalledTimes(1);
    });

    it('user keeps the panel open when a popup callback fails', async () => {
        let handlers:
            | {
                  onSessionOpen: (sessionId: number) => void;
                  onSessionSearchQueryChange: (query: string) => void;
              }
            | undefined;
        vi.mocked(popupManager.listen).mockImplementation(async (nextHandlers) => {
            handlers = nextHandlers as typeof handlers;
            return () => undefined;
        });
        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => Promise.reject(new Error('open failed')),
                onSessionSearchQueryChange: () => Promise.reject(new Error('search failed')),
                onClose: () => undefined,
            })
        );

        await mounted.result.open();
        handlers?.onSessionOpen(3);
        handlers?.onSessionSearchQueryChange('missing');
        await Promise.resolve();
        await Promise.resolve();

        expect(mounted.result.isOpen.value).toBe(true);

        mounted.unmount();
    });

    it('user gets the panel closed even when the close handler fails', async () => {
        let onCloseListener:
            | ((payload: {
                  popupId: string;
                  popupSessionVersion: number;
                  windowLabel: string;
                  type: 'session-history-popup';
              }) => void)
            | undefined;
        vi.mocked(popupManager.listen).mockImplementation(async (handlers) => {
            onCloseListener = handlers.onClose as typeof onCloseListener;
            return () => undefined;
        });
        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => Promise.reject(new Error('close failed')),
            })
        );

        await mounted.result.open();
        onCloseListener?.({
            popupId: 'popup-session-history-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
            type: 'session-history-popup',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(mounted.result.isOpen.value).toBe(false);

        mounted.unmount();
    });

    it('user still gets the panel when listener registration fails', async () => {
        vi.mocked(popupManager.listen).mockRejectedValue(new Error('listener unavailable'));
        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => undefined,
            })
        );

        await Promise.resolve();
        await Promise.resolve();
        await mounted.result.open();

        expect(mounted.result.isOpen.value).toBe(true);

        mounted.unmount();
    });

    it('user still leaves the search view when the popup cannot be hidden', async () => {
        vi.mocked(popupManager.hide).mockRejectedValue(new Error('hide failed'));
        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => document.createElement('button'),
                getPopupData: () => createPopupData(),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => undefined,
            })
        );

        await mounted.result.open();
        expect(() => mounted.unmount()).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();

        expect(popupManager.hide).toHaveBeenCalledTimes(1);
    });
});
