import { getSessionStatusReminderContent } from '@/app/api/agent/history';
import {
    buildWaitingApprovalBody,
    buildWaitingUserQuestionBody,
    previewNotificationText,
    summarizeLatestAssistantResponse,
} from '@/app/api/agent/reminders';
import type { SessionStatusReminderPayload } from '@/app/workflows/windows/events';
import { AppEvent, eventService } from '@/app/workflows/windows/events';
import { tt } from '@/i18n';
import type { TaskViewSnapshot } from '@/modules/agent/contracts';

export function buildSessionStatusReminder(
    snapshot: TaskViewSnapshot
): SessionStatusReminderPayload | null {
    if (snapshot.status === 'completed') {
        return {
            kind: 'completed',
            title: tt('任务已完成'),
            body:
                summarizeLatestAssistantResponse(snapshot.sessionHistory) ??
                getSessionStatusReminderContent('completed'),
            approval: null,
            replyPlaceholder: tt('回复 TouchAI'),
            replyLabel: tt('回复'),
        };
    }

    if (snapshot.status === 'failed') {
        return {
            kind: 'failed',
            title: tt('任务失败'),
            body:
                previewNotificationText(snapshot.error) ??
                summarizeLatestAssistantResponse(snapshot.sessionHistory) ??
                getSessionStatusReminderContent('failed'),
            approval: null,
            replyPlaceholder: tt('回复 TouchAI'),
            replyLabel: tt('回复'),
        };
    }

    if (snapshot.status !== 'waiting_approval') {
        return null;
    }

    if (snapshot.pendingUserQuestion && !snapshot.pendingToolApproval) {
        return {
            kind: 'waiting_approval',
            title: tt('等待回复'),
            body: buildWaitingUserQuestionBody(snapshot.pendingUserQuestion),
            approval: null,
        };
    }

    if (!snapshot.pendingToolApproval) {
        return null;
    }

    return {
        kind: 'waiting_approval',
        title: tt('等待批准'),
        body: buildWaitingApprovalBody(snapshot.pendingToolApproval),
        approval: {
            callId: snapshot.pendingToolApproval.callId,
            approveLabel: tt('批准'),
            rejectLabel: tt('拒绝'),
            decisionId: snapshot.pendingToolApproval.decisionId,
        },
    };
}

/** Coalesce cross-window status notifications without owning task state. */
export function createTaskStatusPublisher() {
    const previous = new Map<
        string,
        { sessionId: number; status: TaskViewSnapshot['status']; reminder: string }
    >();
    return Object.freeze({
        publish(snapshot: TaskViewSnapshot) {
            if (snapshot.sessionId === null) return;
            const reminder = buildSessionStatusReminder(snapshot);
            const key = JSON.stringify(reminder);
            const last = previous.get(snapshot.taskId);
            if (
                last?.sessionId === snapshot.sessionId &&
                last.status === snapshot.status &&
                last.reminder === key
            )
                return;
            previous.set(snapshot.taskId, {
                sessionId: snapshot.sessionId,
                status: snapshot.status,
                reminder: key,
            });
            void eventService
                .emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
                    sessionId: snapshot.sessionId,
                    taskId: snapshot.taskId,
                    status: snapshot.status,
                    previousStatus: last?.sessionId === snapshot.sessionId ? last.status : null,
                    reminder,
                })
                .catch(() => undefined);
        },
        release: (taskId: string) => {
            previous.delete(taskId);
        },
        dispose: () => {
            previous.clear();
        },
    });
}
