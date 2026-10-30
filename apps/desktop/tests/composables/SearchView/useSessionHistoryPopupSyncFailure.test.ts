import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));

vi.mock('@services/ObservabilityService', () => ({
    log: { error: errorMock, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

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

vi.mock('@services/PopupService', () => ({
    popupManager: { ...popupManagerMock, state: popupManagerState },
}));

import { useSessionHistoryPopup } from '@/views/SearchView/composables/useSessionHistoryPopup';

describe('when the history panel cannot receive its first data push', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        popupManagerMock.show.mockResolvedValue('popup-session-history-popup:1');
        popupManagerMock.hide.mockResolvedValue(undefined);
        popupManagerMock.updateData.mockRejectedValue(new Error('window gone'));
        popupManagerMock.listen.mockResolvedValue(() => undefined);
    });

    it('user still gets an open panel and the failure is only logged', async () => {
        const onPopupSessionStart = vi.fn();
        const anchor = document.createElement('button');

        const mounted = await mountComposable(() =>
            useSessionHistoryPopup({
                getAnchorElement: () => anchor,
                getPopupData: () => ({
                    sessions: [],
                    activeSessionId: null,
                    searchQuery: '',
                    isLoading: false,
                }),
                isSessionHistoryActive: () => true,
                onSessionOpen: () => undefined,
                onSessionSearchQueryChange: () => undefined,
                onClose: () => undefined,
                onPopupSessionStart,
            })
        );

        await expect(mounted.result.open()).resolves.toBeUndefined();

        expect(mounted.result.isOpen.value).toBe(true);
        expect(onPopupSessionStart).toHaveBeenCalledTimes(1);
        expect(errorMock).toHaveBeenCalledWith(
            '[SearchView] Failed to sync history popup data:',
            expect.any(Error)
        );

        mounted.unmount();
    });
});
