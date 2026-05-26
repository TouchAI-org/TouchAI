import type {
    SessionStatusReminderActionEvent,
    SessionTaskStatusChangedEvent,
} from '@services/EventService/types';
import { native } from '@services/NativeService';
import type {
    SessionStatusReminderNotificationKind,
    SessionStatusReminderNotificationPayload,
} from '@services/NativeService/types';

interface SessionStatusReminderCoordinatorOptions {
    isSearchSurfaceVisible: () => boolean;
    onReminderAction?: (payload: SessionStatusReminderActionEvent) => void | Promise<void>;
}

function setTrayStatusIndicator(kind: SessionStatusReminderNotificationKind | null) {
    const request = kind
        ? native.window.setTrayStatusIndicator(kind)
        : native.window.clearTrayStatusIndicator();
    const action = kind ? 'update' : 'clear';
    void request.catch((error) => {
        console.error(`[SearchView] Failed to ${action} tray status indicator:`, error);
    });
}

function clearNativeStatusReminderNotifications() {
    void native.window.clearSessionStatusReminderNotifications().catch((error) => {
        console.error('[SearchView] Failed to clear session status reminder notifications:', error);
    });
}

function showNativeStatusReminderNotification(payload: SessionStatusReminderNotificationPayload) {
    void native.window.showSessionStatusReminderNotification(payload).catch((error) => {
        console.error('[SearchView] Failed to send session status reminder notification:', error);
    });
}

export function createSessionStatusReminderCoordinator(
    options: SessionStatusReminderCoordinatorOptions
) {
    function clearReminderState() {
        setTrayStatusIndicator(null);
        clearNativeStatusReminderNotifications();
    }

    function handleSurfaceVisible() {
        clearReminderState();
    }

    function handleTaskStatusChanged(payload: SessionTaskStatusChangedEvent) {
        if (
            payload.previousStatus === 'waiting_approval' &&
            payload.status !== 'waiting_approval'
        ) {
            clearReminderState();
        }

        if (!payload.reminder || options.isSearchSurfaceVisible()) {
            return;
        }

        showNativeStatusReminderNotification({
            ...payload.reminder,
            sessionId: payload.sessionId,
            taskId: payload.taskId,
            approval: payload.reminder.approval ?? null,
        });
        setTrayStatusIndicator(payload.reminder.kind);
    }

    async function handleReminderAction(payload: SessionStatusReminderActionEvent) {
        clearReminderState();
        await Promise.resolve(options.onReminderAction?.(payload)).catch((error) => {
            console.error('[SearchView] Failed to handle session status reminder action:', error);
        });
    }

    return {
        handleSurfaceVisible,
        handleReminderAction,
        handleTaskStatusChanged,
    };
}
