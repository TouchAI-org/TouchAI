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

function logFailure(message: string) {
    return (error: unknown) => {
        console.error(`[SearchView] ${message}:`, error);
    };
}

function setTrayStatusIndicator(kind: SessionStatusReminderNotificationKind | null) {
    const request = kind
        ? native.window.setTrayStatusIndicator(kind)
        : native.window.clearTrayStatusIndicator();
    const action = kind ? 'update' : 'clear';
    void request.catch(logFailure(`Failed to ${action} tray status indicator`));
}

function clearNativeStatusReminderNotifications() {
    void native.window
        .clearSessionStatusReminderNotifications()
        .catch(logFailure('Failed to clear session status reminder notifications'));
}

function showNativeStatusReminderNotification(payload: SessionStatusReminderNotificationPayload) {
    void native.window
        .showSessionStatusReminderNotification(payload)
        .catch(logFailure('Failed to send session status reminder notification'));
}

export function createSessionStatusReminderCoordinator(
    options: SessionStatusReminderCoordinatorOptions
) {
    let hasActiveReminder = false;

    function clearReminderStateUnconditionally() {
        hasActiveReminder = false;
        setTrayStatusIndicator(null);
        clearNativeStatusReminderNotifications();
    }

    function clearReminderState() {
        if (!hasActiveReminder) {
            return;
        }
        clearReminderStateUnconditionally();
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
        hasActiveReminder = true;
    }

    async function handleReminderAction(payload: SessionStatusReminderActionEvent) {
        clearReminderStateUnconditionally();
        await Promise.resolve(options.onReminderAction?.(payload)).catch(
            logFailure('Failed to handle session status reminder action')
        );
    }

    return {
        handleSurfaceVisible,
        handleReminderAction,
        handleTaskStatusChanged,
    };
}
