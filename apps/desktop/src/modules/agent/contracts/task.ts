import type {
    AttachmentReference,
    InputHistorySnapshot,
    PendingToolApproval,
    SessionMessage,
} from './history';
import type { AskUserQuestion } from './presentation';

export type TaskExecutionMode = 'foreground' | 'background';
export type SessionTaskStatus =
    | 'running'
    | 'waiting_approval'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface TaskModelSummary {
    modelDbId: number | null;
    providerId: number;
    providerName: string;
    modelId: string;
    modelName: string;
}

export interface TaskTurnSummary {
    id: number;
    sessionId: number | null;
    status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
}

export interface TaskResult {
    model: TaskModelSummary;
    response: string;
    reasoning: string;
    turn: TaskTurnSummary | null;
}

export interface StartSessionTaskOptions {
    prompt: string;
    userMessageId?: string;
    pendingMessageId?: string;
    sessionId?: number;
    modelId?: string;
    providerId?: number;
    attachments?: AttachmentReference[];
    inputSnapshot?: InputHistorySnapshot;
    executionMode?: TaskExecutionMode;
    signal?: AbortSignal;
    pendingUserMessages?: PendingUserMessage[];
}

export type PendingUserMessageDelivery = 'queue' | 'priority';

export interface PendingUserMessageInput {
    prompt: string;
    attachments?: AttachmentReference[];
    inputSnapshot?: InputHistorySnapshot;
    modelId?: string;
    providerId?: number;
}

export interface PendingUserMessage extends PendingUserMessageInput {
    id: string;
    delivery: PendingUserMessageDelivery;
    editing?: boolean;
    immediate?: boolean;
    attachments: AttachmentReference[];
    createdAt: number;
}

export interface DeliveredPendingUserMessage {
    id: string;
    sourceMessageId?: number;
    prompt: string;
    attachments: AttachmentReference[];
    inputSnapshot?: InputHistorySnapshot;
}

export interface PendingMessageCommands {
    enqueueTaskUserMessage(
        taskId: string,
        input: PendingUserMessageInput,
        delivery: PendingUserMessageDelivery
    ): PendingUserMessage | null;
    enqueueSessionUserMessage(
        sessionId: number,
        input: PendingUserMessageInput,
        delivery: PendingUserMessageDelivery
    ): PendingUserMessage | null;
    updateTaskUserMessage(
        taskId: string,
        messageId: string,
        input: PendingUserMessageInput
    ): boolean;
    updateSessionUserMessage(
        sessionId: number,
        messageId: string,
        input: PendingUserMessageInput
    ): boolean;
    setTaskUserMessageEditing(taskId: string, messageId: string, editing: boolean): boolean;
    setSessionUserMessageEditing(sessionId: number, messageId: string, editing: boolean): boolean;
    clearUserMessageEditing(messageId: string): boolean;
    removeTaskUserMessage(taskId: string, messageId: string): boolean;
    removeSessionUserMessage(sessionId: number, messageId: string): boolean;
    promoteTaskUserMessage(taskId: string, messageId: string): boolean;
    promoteSessionUserMessage(sessionId: number, messageId: string): boolean;
    reorderTaskQueuedMessages(taskId: string, orderedQueueIds: readonly string[]): boolean;
    reorderSessionQueuedMessages(sessionId: number, orderedQueueIds: readonly string[]): boolean;
    clearTaskUserMessages(taskId: string): boolean;
    clearSessionUserMessages(sessionId: number): boolean;
    updateTaskUserMessageModel(
        taskId: string,
        modelId: string | null,
        providerId: number | null
    ): boolean;
    restoreSessionQueue(sessionId: number): Promise<PendingUserMessage[]>;
    resumeSessionQueue(sessionId: number): void;
}

export interface PendingUserQuestionView {
    callId: string;
    sourceMessageId: string;
    questions: AskUserQuestion[];
    createdAt: number;
    decisionId?: string;
}

export interface TaskViewSnapshot {
    taskId: string;
    sessionId: number | null;
    turnId: number | null;
    status: SessionTaskStatus;
    executionMode: TaskExecutionMode;
    sessionHistory: SessionMessage[];
    pendingUserMessages: PendingUserMessage[];
    pendingToolApproval: PendingToolApproval | null;
    pendingApprovals: PendingToolApproval[];
    pendingUserQuestion: PendingUserQuestionView | null;
    error: string | null;
    currentModel: TaskModelSummary | null;
    startedAt: number;
    updatedAt: number;
    modelSwitchCount: number;
}

export interface StartedSessionTask {
    taskId: string;
    sessionId: number | null;
    completion: Promise<TaskResult>;
}
export type TaskSnapshotListener = (snapshot: TaskViewSnapshot) => void;

export function cloneTaskValue<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}
