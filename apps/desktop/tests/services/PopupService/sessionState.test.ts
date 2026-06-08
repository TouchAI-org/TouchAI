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

describe('createPopupSessionState', () => {
    it('replays the pending payload after the popup window becomes ready', () => {
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

    it('replays the latest current payload when an already-ready popup reports ready again', () => {
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

    it('keeps the initial show marker when the same session receives an update before ready', () => {
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

    it('ignores stale close events but clears the active session when the current session closes', () => {
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

    it('drops queued popup data when the current session is reset before the popup becomes ready', () => {
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
