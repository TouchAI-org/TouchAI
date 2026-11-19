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
    sessionId?: number;
    modelId?: string;
    providerId?: number;
    attachments?: AttachmentReference[];
    inputSnapshot?: InputHistorySnapshot;
    executionMode?: TaskExecutionMode;
    signal?: AbortSignal;
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
