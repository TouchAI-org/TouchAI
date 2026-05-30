import type {
    SessionStatusReminderActionEvent,
    SessionTaskStatusChangedEvent,
} from '@services/EventService/types';
import { native } from '@services/NativeService';
import type {
    SessionStatusReminderNotificationKind,
    SessionStatusReminderNotificationPayload,
} from '@services/NativeService/types';

import { tt } from '@/i18n';

interface SessionStatusReminderCoordinatorOptions {
    isSearchSurfaceForegrounded: () => boolean;
    onReminderAction?: (payload: SessionStatusReminderActionEvent) => void | Promise<void>;
}

/** 创建错误日志的柯里化处理器。 */
function logFailure(message: string) {
    return (error: unknown) => {
        console.error(`[SearchView] ${message}:`, error);
    };
}

/** 更新或清除系统托盘的状态指示器图标。 */
function setTrayStatusIndicator(kind: SessionStatusReminderNotificationKind | null) {
    const request = kind
        ? native.window.setTrayStatusIndicator(kind)
        : native.window.clearTrayStatusIndicator();
    const action = kind ? 'update' : 'clear';
    void request.catch(logFailure(`Failed to ${action} tray status indicator`));
}

/** 清除所有已发送的原生状态提醒通知。 */
function clearNativeStatusReminderNotifications() {
    void native.window
        .clearSessionStatusReminderNotifications()
        .catch(logFailure('Failed to clear session status reminder notifications'));
}

/** 发送原生状态提醒通知（如系统通知中心）。 */
function showNativeStatusReminderNotification(payload: SessionStatusReminderNotificationPayload) {
    void native.window
        .showSessionStatusReminderNotification(payload)
        .catch(logFailure('Failed to send session status reminder notification'));
}

/**
 * 创建会话状态提醒协调器，统一管理托盘指示器、原生通知和提醒交互。
 */
export function createSessionStatusReminderCoordinator(
    options: SessionStatusReminderCoordinatorOptions
) {
    let hasActiveReminder = false;

    /** 无条件清除所有提醒状态（指示器 + 通知）。 */
    function clearReminderStateUnconditionally() {
        hasActiveReminder = false;
        setTrayStatusIndicator(null);
        clearNativeStatusReminderNotifications();
    }

    /** 仅在存在活跃提醒时清除状态，避免无意义的 native 调用。 */
    function clearReminderState() {
        if (!hasActiveReminder) {
            return;
        }
        clearReminderStateUnconditionally();
    }

    /** 搜索界面变为可见时清除提醒。 */
    function handleSurfaceVisible() {
        clearReminderState();
    }

    /** 响应任务状态变更事件，决定是否发送通知或清除提醒。 */
    function handleTaskStatusChanged(payload: SessionTaskStatusChangedEvent) {
        if (
            payload.previousStatus === 'waiting_approval' &&
            payload.status !== 'waiting_approval'
        ) {
            clearReminderState();
        }

        if (!payload.reminder || options.isSearchSurfaceForegrounded()) {
            return;
        }

        clearReminderState();

        const hasInlineApprovalActions =
            payload.reminder.kind === 'waiting_approval' && Boolean(payload.reminder.approval);

        showNativeStatusReminderNotification({
            ...payload.reminder,
            sessionId: payload.sessionId,
            taskId: payload.taskId,
            approval: payload.reminder.approval ?? null,
            ...(hasInlineApprovalActions ? {} : { openLabel: tt('打开') }),
        });
        setTrayStatusIndicator(payload.reminder.kind);
        hasActiveReminder = true;
    }

    /** 用户点击通知上的操作按钮后，清除提醒并转发给业务回调。 */
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
