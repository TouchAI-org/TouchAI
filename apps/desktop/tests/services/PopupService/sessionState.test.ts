import { createPopupSessionState } from '@services/PopupService/sessionState';
import type { PopupClosedPayload, PopupDataPayload, PopupType } from '@services/PopupService/types';
import { describe, expect, it } from 'vitest';

function sessionPayload(
    type: PopupType,
    popupId: string,
    popupSessionVersion: number,
    windowLabel: string,
    overrides: Partial<PopupDataPayload> = {}
): PopupDataPayload {
    return {
        type,
        popupId,
        popupSessionVersion,
        windowLabel,
        data: {
            sessions: [],
            activeSessionId: null,
            searchQuery: '',
            isLoading: false,
        },
        ...overrides,
    };
}

function closePayload(
    type: PopupType,
    popupId: string,
    popupSessionVersion: number,
    windowLabel: string
): PopupClosedPayload {
    return {
        type,
        popupId,
        popupSessionVersion,
        windowLabel,
    };
}

describe('user opens a popup window', () => {
    it('user sees the pending content replayed once the popup window is ready', () => {
        const state = createPopupSessionState();
        const session = state.openSession('session-history-popup');
        const initialPayload = sessionPayload(
            session.type,
            session.popupId,
            session.popupSessionVersion,
            session.windowLabel,
            { isShow: true }
        );

        const emitted = state.preparePopupData(initialPayload);
        const replay = state.markWindowReady(session.windowLabel);

        expect(emitted).toEqual(initialPayload);
        expect(replay).toEqual(initialPayload);
        expect(state.markWindowReady(session.windowLabel)).toEqual(initialPayload);
    });

    it('user sees the latest content replayed when a ready popup reports ready again', () => {
        const state = createPopupSessionState();
        const session = state.openSession('model-dropdown-popup');
        const initialPayload = sessionPayload(
            session.type,
            session.popupId,
            session.popupSessionVersion,
            session.windowLabel,
            { isShow: true }
        );
        const updatedPayload = sessionPayload(
            session.type,
            session.popupId,
            session.popupSessionVersion,
            session.windowLabel,
            { isShow: false }
        );

        state.preparePopupData(initialPayload);
        expect(state.markWindowReady(session.windowLabel)).toEqual(initialPayload);

        state.preparePopupData(updatedPayload);

        expect(state.markWindowReady(session.windowLabel)).toEqual(updatedPayload);
    });

    it('user sees the popup still shown when it is updated before it becomes ready', () => {
        const state = createPopupSessionState();
        const session = state.openSession('model-dropdown-popup');
        const initialPayload = sessionPayload(
            session.type,
            session.popupId,
            session.popupSessionVersion,
            session.windowLabel,
            { isShow: true }
        );
        const updatePayload = sessionPayload(
            session.type,
            session.popupId,
            session.popupSessionVersion,
            session.windowLabel,
            { isShow: false }
        );

        state.preparePopupData(initialPayload);
        state.preparePopupData(updatePayload);
        const replay = state.markWindowReady(session.windowLabel);

        expect(replay).toEqual({
            ...updatePayload,
            isShow: true,
        });
    });

    it('user sees stale close events ignored while the open popup is cleared when it closes', () => {
        const state = createPopupSessionState();
        const firstSession = state.openSession('session-history-popup');
        const secondSession = state.openSession('session-history-popup');

        const staleClose = state.finalizeClosed(
            closePayload(
                firstSession.type,
                firstSession.popupId,
                firstSession.popupSessionVersion,
                firstSession.windowLabel
            )
        );

        const currentClose = state.finalizeClosed(
            closePayload(
                secondSession.type,
                secondSession.popupId,
                secondSession.popupSessionVersion,
                secondSession.windowLabel
            )
        );

        expect(staleClose).toBe(false);
        expect(state.snapshot()).toEqual({
            isOpen: false,
            currentType: null,
            currentPopupId: null,
            currentWindowLabel: null,
            currentPopupSessionVersion: null,
        });
        expect(currentClose).toBe(true);

        const nextSession = state.openSession('session-history-popup');
        expect(nextSession.popupSessionVersion).toBe(3);
    });

    it('user sees queued content dropped when the popup is reset before it becomes ready', () => {
        const state = createPopupSessionState();
        const session = state.openSession('session-history-popup');
        const pendingPayload = sessionPayload(
            session.type,
            session.popupId,
            session.popupSessionVersion,
            session.windowLabel,
            { isShow: true }
        );

        state.preparePopupData(pendingPayload);
        state.resetCurrentSession(session.popupId);

        expect(state.snapshot()).toEqual({
            isOpen: false,
            currentType: null,
            currentPopupId: null,
            currentWindowLabel: null,
            currentPopupSessionVersion: null,
        });
        expect(state.markWindowReady(session.windowLabel)).toBeNull();
    });
});
