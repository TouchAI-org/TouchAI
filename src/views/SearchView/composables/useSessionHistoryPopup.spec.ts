import { popupManager, type SessionHistoryData } from '@services/PopupService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountComposable } from '../../../../tests/utils/composables';
import { useSessionHistoryPopup } from './useSessionHistoryPopup';

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

describe('useSessionHistoryPopup', () => {
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

    it('opens the popup and reports the active popup session only when popupManager confirms the same live session', async () => {
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

    it('rejects a popup session that is already stale by the time open resolves', async () => {
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

    it('ignores stale popup close events and only notifies close for the active session', async () => {
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

    it('closes the local popup session without notifying the page when session history is no longer active', async () => {
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

    it('hides the current popup session on unmount when the popup is still open', async () => {
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

    it('cleans up a late popup listener registration if the composable unmounts first', async () => {
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
});
