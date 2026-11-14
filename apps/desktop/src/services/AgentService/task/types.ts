// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import type { InputHistorySnapshot, PendingToolApproval, SessionMessage } from '@/types/session';

import type {
    SessionTaskStatus,
    TaskExecutionMode,
    TaskModelSummary,
    TaskResult,
} from '../contracts/task';
import type { AskUserQuestion } from '../contracts/tooling';

export type { SessionTaskStatus, TaskExecutionMode } from '../contracts/task';

export interface PendingUserQuestionView {
    callId: string;
    sourceMessageId: string;
    questions: AskUserQuestion[];
    createdAt: number;
    /** In-memory interaction identity; never persisted. See `PendingToolApproval.decisionId`. */
    decisionId?: string;
}

/**
 * 任务快照里可能混入来自页面层的响应式代理对象。
 *
 * `structuredClone` 遇到 Vue proxy 会直接抛错，所以这里先尝试它，
 * 失败后再退回到 JSON 克隆，保证任务发布链路不要因为快照复制中断。
 */
export function cloneTaskValue<T>(value: T): T {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // 回退到 JSON 克隆，处理可序列化的响应式代理对象。
        }
    }

    return JSON.parse(JSON.stringify(value)) as T;
}

export interface StartSessionTaskOptions {
    prompt: string;
    sessionId?: number;
    modelId?: string;
    providerId?: number;
    attachments?: AttachmentIndex[];
    inputSnapshot?: InputHistorySnapshot;
    executionMode?: TaskExecutionMode;
    signal?: AbortSignal;
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

/**
 * Compatibility alias kept while callers migrate to the explicit name.
 * The public fields are the `TaskViewSnapshot` whitelist; it never carries
 * checkpoints, prompt internals, or provider credentials.
 */
export type SessionTaskSnapshot = TaskViewSnapshot;
export type SessionTaskViewSnapshot = TaskViewSnapshot;

export interface StartedSessionTask {
    taskId: string;
    sessionId: number | null;
    completion: Promise<TaskResult>;
}

export type TaskSnapshotListener = (snapshot: TaskViewSnapshot) => void;
