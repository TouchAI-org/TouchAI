import { tt } from '@/i18n';

export type {
    ApprovalMessagePart,
    AttachmentReference,
    ContextCompactionMessagePart,
    InputHistoryDocument,
    InputHistorySnapshot,
    LoadedSessionInfo,
    PendingToolApproval,
    ReasoningMessagePart,
    SelectedSkill,
    SessionMessage,
    SessionPart,
    TextMessagePart,
    ToolApprovalInfo,
    ToolCallInfo,
    ToolCallMessagePart,
    ToolExecutionSource,
    WidgetInfo,
    WidgetMessagePart,
} from '@/modules/agent/public';
export {
    cloneInputHistorySnapshot,
    createInputHistorySnapshot,
    createReasoningPart,
    createTextPart,
    createToolCallPart,
    findToolCallPart,
    getInputHistorySnapshotKey,
    hasInputHistorySnapshotContent,
    selectToolCalls,
    ToolCallStatus,
} from '@/modules/agent/public';

export type SessionStatusReminderKind = 'completed' | 'failed' | 'waiting_approval';

export function getSessionStatusReminderContent(status: SessionStatusReminderKind): string {
    switch (status) {
        case 'completed':
            return tt('任务已完成');
        case 'failed':
            return tt('任务失败');
        case 'waiting_approval':
            return tt('任务正在等待批准');
    }
}
