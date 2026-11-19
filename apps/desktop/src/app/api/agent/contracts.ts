import type {
    AskUserAnswer,
    PendingMessageCommands,
    SessionMessage,
    StartedSessionTask,
    StartSessionTaskOptions,
    TaskSnapshotListener,
    TaskViewSnapshot,
} from '@/modules/agent/public';

export type {
    AskUserAnswer,
    AttachmentReference,
    InputHistorySnapshot,
    PendingMessageCommands,
    PendingUserMessage,
    PendingUserMessageDelivery,
    PendingUserMessageInput,
    SessionMessage,
    StartedSessionTask,
    StartSessionTaskOptions,
    TaskSnapshotListener,
    TaskViewSnapshot,
} from '@/modules/agent/public';
export type {
    ContextCompactionMessagePart,
    LoadedSessionInfo,
    PendingToolApproval,
    PendingUserQuestionView,
    ReasoningMessagePart,
    SessionPart,
    SessionTaskStatus,
    TaskModelSummary,
    TextMessagePart,
    ToolApprovalInfo,
    ToolCallInfo,
    ToolCallMessagePart,
    ToolExecutionSource,
    WidgetInfo,
} from '@/modules/agent/public';

export interface SessionInformation {
    sessionId: number;
    title: string;
    modelId: string | null;
    providerId: number | null;
}

export interface AgentCommands extends PendingMessageCommands {
    startTask(options: StartSessionTaskOptions): Promise<StartedSessionTask>;
    startBackgroundTask(options: StartSessionTaskOptions): Promise<StartedSessionTask>;
    cancelTask(taskId: string, options?: { preservePending?: boolean }): boolean;
    approveTaskToolCall(taskId: string, callId?: string, decisionId?: string): boolean;
    rejectTaskToolCall(taskId: string, callId?: string, decisionId?: string): boolean;
    settleTaskUserQuestion(
        taskId: string,
        callId: string,
        answers: AskUserAnswer[] | null,
        decisionId?: string
    ): boolean;
    attachSessionView(sessionId: number): { taskId: string; snapshot: TaskViewSnapshot } | null;
    getTaskSnapshot(taskId: string): TaskViewSnapshot | null;
    subscribeTask(taskId: string, listener: TaskSnapshotListener): () => void;
    getSessionStatus(
        sessionId: number
    ): { status: TaskViewSnapshot['status']; taskId: string } | null;
    listActiveTasks(): TaskViewSnapshot[];
}

export interface AgentQueries {
    getSession(sessionId: number): Promise<SessionInformation>;
    loadSession(sessionId: number): Promise<SessionInformation & { history: SessionMessage[] }>;
}

export interface AgentApi extends AgentCommands, AgentQueries {}
