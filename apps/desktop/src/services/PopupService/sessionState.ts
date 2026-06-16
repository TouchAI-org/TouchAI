// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    PopupClosedPayload,
    PopupDataPayload,
    PopupSessionIdentity,
    PopupType,
} from './types';

export interface PopupManagerStateSnapshot {
    isOpen: boolean;
    currentType: PopupType | null;
    currentPopupId: string | null;
    currentWindowLabel: string | null;
    currentPopupSessionVersion: number | null;
}

interface PopupSessionRecord extends PopupSessionIdentity {
    type: PopupType;
}

export interface PopupSessionState {
    snapshot: () => PopupManagerStateSnapshot;
    isCurrentPopupEvent: (payload: PopupSessionIdentity) => boolean;
    openSession: (type: PopupType) => PopupSessionRecord;
    preparePopupData: (payload: PopupDataPayload) => PopupDataPayload;
    markWindowReady: (windowLabel: string) => PopupDataPayload | null;
    getClosePayload: (identity?: PopupSessionIdentity) => PopupClosedPayload | null;
    finalizeClosed: (payload: PopupClosedPayload) => boolean;
    resetCurrentSession: (popupId: string) => void;
}

function buildPopupId(windowLabel: string, popupSessionVersion: number) {
    return `${windowLabel}:${popupSessionVersion}`;
}

function getWindowLabel(type: PopupType) {
    return `popup-${type}`;
}

export function createPopupSessionState(): PopupSessionState {
    let isOpen = false;
    let currentType: PopupType | null = null;
    let currentPopupId: string | null = null;
    let currentWindowLabel: string | null = null;
    let currentPopupSessionVersion: number | null = null;

    const readyPopupWindows = new Set<string>();
    const pendingPopupDataByWindow = new Map<string, PopupDataPayload>();
    const latestPopupDataByWindow = new Map<string, PopupDataPayload>();
    const popupSessionVersionByWindow = new Map<string, number>();

    function snapshot(): PopupManagerStateSnapshot {
        return {
            isOpen,
            currentType,
            currentPopupId,
            currentWindowLabel,
            currentPopupSessionVersion,
        };
    }

    function isCurrentPopupEvent(payload: PopupSessionIdentity) {
        return (
            currentPopupId === payload.popupId &&
            currentWindowLabel === payload.windowLabel &&
            currentPopupSessionVersion === payload.popupSessionVersion
        );
    }

    function openSession(type: PopupType): PopupSessionRecord {
        const windowLabel = getWindowLabel(type);
        const popupSessionVersion = (popupSessionVersionByWindow.get(windowLabel) ?? 0) + 1;
        const popupId = buildPopupId(windowLabel, popupSessionVersion);

        popupSessionVersionByWindow.set(windowLabel, popupSessionVersion);
        currentType = type;
        currentPopupId = popupId;
        currentWindowLabel = windowLabel;
        currentPopupSessionVersion = popupSessionVersion;
        isOpen = true;

        return {
            type,
            popupId,
            windowLabel,
            popupSessionVersion,
        };
    }

    function preparePopupData(payload: PopupDataPayload) {
        const windowLabel = payload.windowLabel ?? '';
        const shouldQueuePending = windowLabel.length > 0 && !readyPopupWindows.has(windowLabel);
        const existingPayload = shouldQueuePending
            ? pendingPopupDataByWindow.get(windowLabel)
            : undefined;
        const nextPayload =
            existingPayload &&
            existingPayload.popupId === payload.popupId &&
            existingPayload.isShow &&
            payload.isShow !== true
                ? {
                      ...payload,
                      isShow: true,
                  }
                : payload;

        if (windowLabel) {
            if (isCurrentPopupEvent(nextPayload)) {
                latestPopupDataByWindow.set(windowLabel, nextPayload);
            }
            if (shouldQueuePending) {
                pendingPopupDataByWindow.set(windowLabel, nextPayload);
            } else {
                pendingPopupDataByWindow.delete(windowLabel);
            }
        }

        return nextPayload;
    }

    function markWindowReady(windowLabel: string) {
        readyPopupWindows.add(windowLabel);
        const pendingPayload = pendingPopupDataByWindow.get(windowLabel) ?? null;
        if (pendingPayload) {
            pendingPopupDataByWindow.delete(windowLabel);
            return pendingPayload;
        }

        const latestPayload = latestPopupDataByWindow.get(windowLabel) ?? null;
        return latestPayload && isCurrentPopupEvent(latestPayload) ? latestPayload : null;
    }

    function getClosePayload(identity?: PopupSessionIdentity): PopupClosedPayload | null {
        if (
            !currentType ||
            !currentPopupId ||
            !currentWindowLabel ||
            currentPopupSessionVersion === null
        ) {
            return null;
        }

        if (
            identity &&
            (currentPopupId !== identity.popupId ||
                currentWindowLabel !== identity.windowLabel ||
                currentPopupSessionVersion !== identity.popupSessionVersion)
        ) {
            return null;
        }

        return {
            type: currentType,
            popupId: currentPopupId,
            windowLabel: currentWindowLabel,
            popupSessionVersion: currentPopupSessionVersion,
        };
    }

    function finalizeClosed(payload: PopupClosedPayload) {
        if (
            currentType !== payload.type ||
            currentPopupId !== payload.popupId ||
            currentWindowLabel !== payload.windowLabel ||
            currentPopupSessionVersion !== payload.popupSessionVersion
        ) {
            return false;
        }

        pendingPopupDataByWindow.delete(payload.windowLabel);
        latestPopupDataByWindow.delete(payload.windowLabel);
        currentPopupId = null;
        currentWindowLabel = null;
        currentPopupSessionVersion = null;
        currentType = null;
        isOpen = false;
        return true;
    }

    function resetCurrentSession(popupId: string) {
        if (currentPopupId !== popupId) {
            return;
        }

        if (currentWindowLabel) {
            pendingPopupDataByWindow.delete(currentWindowLabel);
            latestPopupDataByWindow.delete(currentWindowLabel);
        }
        currentPopupId = null;
        currentWindowLabel = null;
        currentPopupSessionVersion = null;
        currentType = null;
        isOpen = false;
    }

    return {
        snapshot,
        isCurrentPopupEvent,
        openSession,
        preparePopupData,
        markWindowReady,
        getClosePayload,
        finalizeClosed,
        resetCurrentSession,
    };
}
