// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import type { PendingToolApproval, SessionMessage } from '@/types/session';

import type { TaskModelSummary } from '../execution';
import type { AttemptCheckpoint } from '../execution/executor';
import type { ExecuteRequestResult } from '../execution/runtime';
import type { PromptSnapshot } from '../prompt/types';

/**
 * 任务执行模式。
 *
 * `foreground` 表示当前有前台视图直接观察；
 * `background` 表示任务允许脱离当前页面继续运行。
 */
export type TaskExecutionMode = 'foreground' | 'background';

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

export type SessionTaskStatus =
    | 'running'
    | 'waiting_approval'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface StartSessionTaskOptions {
    prompt: string;
    sessionId?: number;
    modelId?: string;
    providerId?: number;
    attachments?: AttachmentIndex[];
    executionMode?: TaskExecutionMode;
    signal?: AbortSignal;
}

export interface SessionTaskSnapshot {
    taskId: string;
    sessionId: number | null;
    turnId: number | null;
    status: SessionTaskStatus;
    executionMode: TaskExecutionMode;
    prompt: string;
    sessionHistory: SessionMessage[];
    pendingToolApproval: PendingToolApproval | null;
    pendingApprovals: PendingToolApproval[];
    error: string | null;
    currentModel: TaskModelSummary | null;
    promptSnapshot: PromptSnapshot | null;
    lastCheckpoint: AttemptCheckpoint | null;
    startedAt: number;
    updatedAt: number;
    modelSwitchCount: number;
}

export interface StartedSessionTask {
    taskId: string;
    sessionId: number | null;
    completion: Promise<ExecuteRequestResult>;
}

export type TaskSnapshotListener = (snapshot: SessionTaskSnapshot) => void;
