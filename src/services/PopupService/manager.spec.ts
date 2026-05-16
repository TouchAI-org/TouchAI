import { AppEvent } from '@services/EventService';
import { emit } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getTauriInvokeCalls,
    installTauriMocks,
    resetTauriMocks,
} from '../../../tests/utils/tauri';
import { createPopupManager } from './manager';

vi.mock('./registry', () => ({
    initializeBuiltInPopups: vi.fn(),
    popupRegistry: {
        getSerializableConfig: vi.fn(() => [
            { id: 'session-history-popup', width: 320, height: 384 },
            { id: 'model-dropdown-popup', width: 320, height: 384 },
        ]),
        get: vi.fn((type: string) => ({
            width: 320,
            height: 384,
            calculatePosition: () => ({ x: 40, y: 120 }),
            id: type,
        })),
    },
}));

vi.mock('@tauri-apps/api/window', () => {
    const logicalPoint = { x: 20, y: 30 };
    const logicalSize = { width: 800, height: 600 };

    return {
        getCurrentWindow: () => ({
            scaleFactor: vi.fn().mockResolvedValue(1),
            outerPosition: vi.fn().mockResolvedValue({ toLogical: () => logicalPoint }),
            outerSize: vi.fn().mockResolvedValue({ toLogical: () => logicalSize }),
            innerSize: vi.fn().mockResolvedValue({ toLogical: () => logicalSize }),
        }),
        currentMonitor: vi.fn().mockResolvedValue(null),
    };
});

function buildAnchor() {
    const trigger = document.createElement('button');
    trigger.className = 'search-view-container';
    document.body.appendChild(trigger);
    return trigger;
}

function getPopupDataEmitCalls() {
    return getTauriInvokeCalls('plugin:event|emit').filter((call) => {
        if (
            !call.payload ||
            Array.isArray(call.payload) ||
            call.payload instanceof ArrayBuffer ||
            call.payload instanceof Uint8Array ||
            typeof call.payload !== 'object' ||
            !('event' in call.payload)
        ) {
            return false;
        }

        return call.payload.event === AppEvent.POPUP_DATA;
    });
}

describe('popupManager', () => {
    beforeEach(() => {
        installTauriMocks();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
        resetTauriMocks();
    });

    it('replays the latest show payload once after a popup window reports ready', async () => {
        const popupManager = createPopupManager();
        const anchor = buildAnchor();

        const popupId = await popupManager.show('session-history-popup', anchor, {
            sessions: [],
            activeSessionId: null,
            searchQuery: 'initial',
            isLoading: false,
        });

        await popupManager.updateData({
            sessions: [],
            activeSessionId: null,
            searchQuery: 'updated-before-ready',
            isLoading: false,
        });

        const popupDataCallsBeforeReady = getPopupDataEmitCalls();
        expect(popupDataCallsBeforeReady).toHaveLength(2);
        expect(popupDataCallsBeforeReady[0]?.payload).toMatchObject({
            event: AppEvent.POPUP_DATA,
            payload: {
                popupId,
                windowLabel: 'popup-session-history-popup',
                popupSessionVersion: 1,
                isShow: true,
            },
        });
        expect(popupDataCallsBeforeReady[1]?.payload).toMatchObject({
            event: AppEvent.POPUP_DATA,
            payload: {
                popupId,
                windowLabel: 'popup-session-history-popup',
                popupSessionVersion: 1,
                isShow: true,
                data: expect.objectContaining({
                    searchQuery: 'updated-before-ready',
                }),
            },
        });

        await emit(AppEvent.POPUP_READY, { windowLabel: 'popup-session-history-popup' });

        const popupDataCallsAfterReady = getPopupDataEmitCalls();
        expect(popupDataCallsAfterReady).toHaveLength(3);
        expect(popupDataCallsAfterReady[2]?.payload).toMatchObject({
            event: AppEvent.POPUP_DATA,
            payload: {
                popupId,
                windowLabel: 'popup-session-history-popup',
                popupSessionVersion: 1,
                isShow: true,
                data: expect.objectContaining({
                    searchQuery: 'updated-before-ready',
                }),
            },
        });

        await emit(AppEvent.POPUP_READY, { windowLabel: 'popup-session-history-popup' });

        const popupDataCallsAfterSecondReady = getPopupDataEmitCalls();
        expect(popupDataCallsAfterSecondReady).toHaveLength(3);
    });

    it('only hides the active popup when the requested identity still matches the current session', async () => {
        const popupManager = createPopupManager();
        const anchor = buildAnchor();
        const firstPopupId = await popupManager.show('model-dropdown-popup', anchor, {
            activeModelId: 'gpt-5',
            activeProviderId: 1,
            selectedModelId: 'gpt-5',
            selectedProviderId: 1,
            searchQuery: '',
            models: [],
        });

        const staleIdentity = {
            popupId: firstPopupId,
            popupSessionVersion: 1,
            windowLabel: 'popup-model-dropdown-popup',
        };

        await emit(AppEvent.POPUP_CLOSED, {
            ...staleIdentity,
            type: 'model-dropdown-popup',
        });

        const nextPopupId = await popupManager.show('model-dropdown-popup', anchor, {
            activeModelId: 'gpt-5',
            activeProviderId: 1,
            selectedModelId: 'gpt-5',
            selectedProviderId: 1,
            searchQuery: 'next-session',
            models: [],
        });

        await popupManager.hide(staleIdentity);
        let hideCalls = getTauriInvokeCalls('hide_popup_window');
        expect(hideCalls).toHaveLength(0);

        await popupManager.hide({
            popupId: nextPopupId,
            popupSessionVersion: 2,
            windowLabel: 'popup-model-dropdown-popup',
        });

        hideCalls = getTauriInvokeCalls('hide_popup_window');
        expect(hideCalls).toHaveLength(1);
        expect(hideCalls[0]).toEqual({
            cmd: 'hide_popup_window',
            payload: {
                params: {
                    popupId: nextPopupId,
                    popupSessionVersion: 2,
                    windowLabel: 'popup-model-dropdown-popup',
                },
            },
        });
    });

    it('delivers close callbacks for every popup close event while keeping stale close events from clearing the current session', async () => {
        const popupManager = createPopupManager();
        const anchor = buildAnchor();
        const onClose = vi.fn();
        const unlisten = await popupManager.listen({ onClose });

        const firstPopupId = await popupManager.show('session-history-popup', anchor, {
            sessions: [],
            activeSessionId: null,
            searchQuery: 'first',
            isLoading: false,
        });

        await emit(AppEvent.POPUP_CLOSED, {
            popupId: firstPopupId,
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
            type: 'session-history-popup',
        });

        const secondPopupId = await popupManager.show('session-history-popup', anchor, {
            sessions: [],
            activeSessionId: null,
            searchQuery: 'second',
            isLoading: false,
        });

        await emit(AppEvent.POPUP_CLOSED, {
            popupId: firstPopupId,
            popupSessionVersion: 1,
            windowLabel: 'popup-session-history-popup',
            type: 'session-history-popup',
        });

        expect(onClose).toHaveBeenCalledTimes(2);
        expect(popupManager.state).toMatchObject({
            isOpen: true,
            currentPopupId: secondPopupId,
            currentWindowLabel: 'popup-session-history-popup',
            currentPopupSessionVersion: 2,
        });

        unlisten();
    });
});
