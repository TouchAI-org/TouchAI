import { AppEvent } from '@services/EventService';
import { describe, expect, it, vi } from 'vitest';

import { createPopupTransport } from './transport';

describe('createPopupTransport', () => {
    it('forwards popup window commands and popup data events through injected boundaries', async () => {
        const emit = vi.fn().mockResolvedValue(undefined);
        const registerPopupConfigs = vi.fn().mockResolvedValue(undefined);
        const preloadPopupWindows = vi.fn().mockResolvedValue(undefined);
        const showPopupWindow = vi.fn().mockResolvedValue(undefined);
        const hidePopupWindow = vi.fn().mockResolvedValue(undefined);
        const transport = createPopupTransport({
            emit,
            registerPopupConfigs,
            preloadPopupWindows,
            showPopupWindow,
            hidePopupWindow,
        });

        const configs = [{ id: 'session-history-popup', width: 320, height: 384 }];
        const popupData = {
            popupId: 'popup-session-history-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
            type: 'session-history-popup' as const,
            data: {
                sessions: [],
                activeSessionId: null,
                searchQuery: '',
                isLoading: false,
            },
            isShow: true,
        };

        await transport.registerConfigs(configs);
        await transport.preloadWindows();
        await transport.showWindow({
            popupId: 'popup-session-history-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
            popupType: 'session-history-popup',
            width: 320,
            height: 384,
            x: 120,
            y: 180,
        });
        await transport.emitPopupData(popupData);
        await transport.hideWindow({
            popupId: 'popup-session-history-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
        });

        expect(registerPopupConfigs).toHaveBeenCalledWith(configs);
        expect(preloadPopupWindows).toHaveBeenCalledTimes(1);
        expect(showPopupWindow).toHaveBeenCalledWith({
            popupId: 'popup-session-history-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
            popupType: 'session-history-popup',
            width: 320,
            height: 384,
            x: 120,
            y: 180,
        });
        expect(emit).toHaveBeenCalledWith(AppEvent.POPUP_DATA, popupData);
        expect(hidePopupWindow).toHaveBeenCalledWith({
            popupId: 'popup-session-history-popup:1',
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
        });
    });
});
