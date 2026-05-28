// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { tt } from '@/i18n';
import { eventService } from '@/services/EventService';
import { AppEvent, type SessionStatusReminderPayload } from '@/services/EventService/types';
import type { PendingToolApproval, SessionMessage } from '@/types/session';
import { getSessionStatusReminderContent } from '@/utils/session';
import { collapseWhitespace } from '@/utils/text';

import { AiError, AiErrorCode } from '../contracts/errors';
import type { ConversationRuntimeEnvironment, TurnEvent } from '../execution';
import { AiRequestExecutor } from '../execution/executor';
import { AiConversationRuntime, type ExecuteRequestResult } from '../execution/runtime';
import { reportRuntimePersistenceIssue } from '../outputs';
import { loadSessionHistory } from '../session/history';
import { SessionTaskProjection } from './projection';
import type {
    SessionTaskSnapshot,
    SessionTaskStatus,
    StartedSessionTask,
    StartSessionTaskOptions,
    TaskSnapshotListener,
} from './types';
import { cloneTaskValue } from './types';

interface MutableSessionTask {
    taskId: string;
    sessionId: number | null;
    subscribers: Set<TaskSnapshotListener>;
    snapshot: SessionTaskSnapshot;
    abortController: AbortController;
    detachAbortRelay: () => void;
    projection: SessionTaskProjection;
    completion: Promise<ExecuteRequestResult> | null;
    releaseTimer: ReturnType<typeof setTimeout> | null;
    lastPublishedStatus: SessionTaskStatus | null;
    lastPublishedSessionId: number | null;
}

const TERMINAL_TASK_RETENTION_MS = 5 * 60 * 1000;
const STATUS_REMINDER_MAX_BODY_CHARS = 220;
const STATUS_REMINDER_MAX_COMMAND_CHARS = 160;

function cloneTaskSnapshot(snapshot: SessionTaskSnapshot): SessionTaskSnapshot {
    return cloneTaskValue(snapshot);
}

function isTerminalStatus(status: SessionTaskSnapshot['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function truncateReminderText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
        return value;
    }

    return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

function summarizeReminderText(
    value: string | null | undefined,
    maxChars = STATUS_REMINDER_MAX_BODY_CHARS
) {
    const normalized = collapseWhitespace(value ?? '');
    if (!normalized) {
        return null;
    }

    return truncateReminderText(normalized, maxChars);
}

function summarizeLatestAssistantResponse(history: SessionMessage[]): string | null {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role !== 'assistant') {
            continue;
        }

        const summary = summarizeReminderText(message.content);
        if (summary) {
            return summary;
        }
    }

    return null;
}

function buildWaitingApprovalBody(approval: PendingToolApproval): string {
    const summary =
        summarizeReminderText(approval.reason) ??
        summarizeReminderText(approval.description) ??
        summarizeReminderText(approval.title) ??
        getSessionStatusReminderContent('waiting_approval');
    const commandPreview = summarizeReminderText(
        approval.command,
        STATUS_REMINDER_MAX_COMMAND_CHARS
    );

    if (!commandPreview || commandPreview === summary) {
        return summary;
    }

    return `${summary}\n${commandPreview}`;
}

function buildSessionStatusReminder(
    snapshot: SessionTaskSnapshot
): SessionStatusReminderPayload | null {
    if (snapshot.status === 'completed') {
        return {
            kind: 'completed',
            title: tt('任务已完成'),
            body:
                summarizeLatestAssistantResponse(snapshot.sessionHistory) ??
                getSessionStatusReminderContent('completed'),
            approval: null,
        };
    }

    if (snapshot.status === 'failed') {
        return {
            kind: 'failed',
            title: tt('任务失败'),
            body:
                summarizeReminderText(snapshot.error) ??
                summarizeLatestAssistantResponse(snapshot.sessionHistory) ??
                getSessionStatusReminderContent('failed'),
            approval: null,
        };
    }

    if (snapshot.status !== 'waiting_approval' || !snapshot.pendingToolApproval) {
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
        },
    };
}

function relayAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
    if (!source) {
        return () => {};
    }

    if (source.aborted) {
        target.abort();
        return () => {};
    }

    const forwardAbort = () => {
        target.abort();
    };

    source.addEventListener('abort', forwardAbort, { once: true });
    return () => {
        source.removeEventListener('abort', forwardAbort);
    };
}

/**
 * 这是 `task` 层自己的宿主环境拼装逻辑，目前只有任务中心消费，
 * 与其额外拆一个单文件模块，不如就近放在 owner 旁边。
 */
async function createConversationRuntimeEnvironment(): Promise<ConversationRuntimeEnvironment> {
    return {
        reportPersistenceIssue: reportRuntimePersistenceIssue,
    };
}

/**
 * 进程级任务管理中心。
 *
 * 这里是 Agent 运行时的唯一 owner：
 * - 注册与查找活跃任务
 * - 维护会话到任务的绑定
 * - 协调任务生命周期、审批与取消
 * - 向页面层发布只读快照
 */
class SessionTaskCenter {
    private readonly tasks = new Map<string, MutableSessionTask>();
    private readonly sessionActiveTaskIndex = new Map<number, string>();
    private readonly executor = new AiRequestExecutor();

    async startTask(options: StartSessionTaskOptions): Promise<StartedSessionTask> {
        this.ensureSessionSlotAvailable(options.sessionId ?? null);

        const taskId = crypto.randomUUID();
        const abortController = new AbortController();
        const detachAbortRelay = relayAbortSignal(options.signal, abortController);
        const snapshot: SessionTaskSnapshot = {
            taskId,
            sessionId: options.sessionId ?? null,
            turnId: null,
            status: 'running',
            executionMode: options.executionMode ?? 'foreground',
            prompt: options.prompt,
            sessionHistory: [],
            pendingToolApproval: null,
            pendingApprovals: [],
            error: null,
            currentModel: null,
            promptSnapshot: null,
            lastCheckpoint: null,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            modelSwitchCount: 0,
        };
        const projection = new SessionTaskProjection(snapshot, () => {
            this.notifySubscribers(taskId);
        });
        const task: MutableSessionTask = {
            taskId,
            sessionId: options.sessionId ?? null,
            subscribers: new Set(),
            snapshot,
            abortController,
            detachAbortRelay,
            projection,
            completion: null,
            releaseTimer: null,
            lastPublishedStatus: null,
            lastPublishedSessionId: null,
        };

        this.tasks.set(taskId, task);
        this.bindTaskToSession(taskId, options.sessionId ?? null);

        try {
            const historyPromise =
                options.sessionId !== undefined && options.sessionId !== null
                    ? loadSessionHistory(options.sessionId)
                    : Promise.resolve([]);
            const runtimeEnvironmentPromise = createConversationRuntimeEnvironment();
            const [historyResult, runtimeEnvironmentResult] = await Promise.allSettled([
                historyPromise,
                runtimeEnvironmentPromise,
            ]);

            if (historyResult.status === 'rejected') {
                console.error(
                    `[SessionTaskCenter] Failed to load history for session ${options.sessionId}:`,
                    historyResult.reason
                );
                throw historyResult.reason;
            }

            if (runtimeEnvironmentResult.status === 'rejected') {
                throw runtimeEnvironmentResult.reason;
            }

            projection.bootstrap(
                historyResult.value,
                options.prompt,
                options.attachments,
                options.inputSnapshot
            );

            const runtime = new AiConversationRuntime(this.executor, {
                taskId,
                prompt: options.prompt,
                sessionId: options.sessionId,
                modelId: options.modelId,
                providerId: options.providerId,
                attachments: options.attachments,
                inputSnapshot: options.inputSnapshot,
                executionMode: options.executionMode ?? 'foreground',
                environment: runtimeEnvironmentResult.value,
                signal: abortController.signal,
                onChunk: (chunk) => {
                    projection.handleChunk(chunk);
                },
                onTurnEvent: (event) => {
                    this.handleTaskEvent(taskId, event);
                    projection.syncTaskMetadata(event);
                },
                requestToolApproval: (payload) => {
                    return projection.requestToolApproval(payload);
                },
            });

            const completion = this.runTask(taskId, runtime);
            task.completion = completion;

            return {
                taskId,
                sessionId: task.sessionId,
                completion,
            };
        } catch (error) {
            this.releaseTask(taskId);
            throw error;
        }
    }

    /**
     * 前台页面发起的新请求默认属于前台任务。
     */
    async startForegroundTask(options: StartSessionTaskOptions): Promise<StartedSessionTask> {
        return this.startTask({
            ...options,
            executionMode: options.executionMode ?? 'foreground',
        });
    }

    /**
     * 预留给后台入口使用的语义化别名。
     */
    async startBackgroundTask(options: StartSessionTaskOptions): Promise<StartedSessionTask> {
        return this.startTask({
            ...options,
            executionMode: 'background',
        });
    }

    cancelTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        task.abortController.abort();
        task.projection.clearPendingApprovals(tt('请求已取消'));
        return true;
    }

    approveTaskToolCall(taskId: string, callId?: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        return task.projection.approvePendingToolApproval(callId);
    }

    rejectTaskToolCall(taskId: string, callId?: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        return task.projection.rejectPendingToolApproval(callId);
    }

    attachSessionView(sessionId: number): { taskId: string; snapshot: SessionTaskSnapshot } | null {
        const taskId = this.sessionActiveTaskIndex.get(sessionId);
        if (!taskId) {
            return null;
        }

        const task = this.tasks.get(taskId);
        if (!task) {
            this.sessionActiveTaskIndex.delete(sessionId);
            return null;
        }

        return {
            taskId,
            snapshot: cloneTaskSnapshot(task.snapshot),
        };
    }

    subscribeTask(taskId: string, listener: TaskSnapshotListener): () => void {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new AiError(AiErrorCode.TASK_NOT_FOUND, { taskId });
        }

        task.subscribers.add(listener);
        listener(cloneTaskSnapshot(task.snapshot));

        return () => {
            task.subscribers.delete(listener);
        };
    }

    unsubscribeTask(taskId: string, listener: TaskSnapshotListener): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        task.subscribers.delete(listener);
    }

    getTaskSnapshot(taskId: string): SessionTaskSnapshot | null {
        const task = this.tasks.get(taskId);
        return task ? cloneTaskSnapshot(task.snapshot) : null;
    }

    getSessionStatus(sessionId: number): {
        status: SessionTaskStatus;
        taskId: string;
    } | null {
        const taskId = this.sessionActiveTaskIndex.get(sessionId);
        if (!taskId) {
            return null;
        }

        const task = this.tasks.get(taskId);
        if (!task) {
            this.sessionActiveTaskIndex.delete(sessionId);
            return null;
        }

        return {
            status: task.snapshot.status,
            taskId: task.taskId,
        };
    }

    listActiveTasks(): SessionTaskSnapshot[] {
        return Array.from(this.tasks.values())
            .filter((task) => !isTerminalStatus(task.snapshot.status))
            .map((task) => cloneTaskSnapshot(task.snapshot));
    }

    private async runTask(
        taskId: string,
        runtime: AiConversationRuntime
    ): Promise<ExecuteRequestResult> {
        try {
            return await runtime.run();
        } catch (error) {
            const task = this.tasks.get(taskId);
            if (task && !isTerminalStatus(task.snapshot.status)) {
                const aiError = AiError.fromError(error);
                if (aiError.is(AiErrorCode.REQUEST_CANCELLED)) {
                    task.projection.markCancelled();
                } else {
                    task.projection.markFailed(aiError.message, aiError.getDisplayMessage());
                }
                this.finalizeTaskLifecycle(taskId);
            }
            throw error;
        } finally {
            const task = this.tasks.get(taskId);
            if (task && isTerminalStatus(task.snapshot.status)) {
                this.scheduleTaskRelease(taskId);
            }
        }
    }

    private ensureSessionSlotAvailable(sessionId: number | null): void {
        if (sessionId === null) {
            return;
        }

        const existingTaskId = this.sessionActiveTaskIndex.get(sessionId);
        if (!existingTaskId) {
            return;
        }

        const existingTask = this.tasks.get(existingTaskId);
        if (!existingTask || isTerminalStatus(existingTask.snapshot.status)) {
            this.sessionActiveTaskIndex.delete(sessionId);
            return;
        }

        throw new AiError(AiErrorCode.SESSION_ACTIVE_TASK_EXISTS, {
            sessionId,
            activeTaskId: existingTaskId,
        });
    }

    private handleTaskEvent(taskId: string, event: TurnEvent): void {
        if (!this.tasks.has(taskId)) {
            return;
        }

        if (event.type === 'task_started') {
            this.bindTaskToSession(taskId, event.sessionId);
            return;
        }

        if (
            event.type === 'task_completed' ||
            event.type === 'task_failed' ||
            event.type === 'task_cancelled'
        ) {
            this.finalizeTaskLifecycle(taskId);
        }
    }

    private bindTaskToSession(taskId: string, sessionId: number | null): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        if (task.sessionId !== null) {
            const indexedTaskId = this.sessionActiveTaskIndex.get(task.sessionId);
            if (indexedTaskId === taskId) {
                this.sessionActiveTaskIndex.delete(task.sessionId);
            }
        }

        task.sessionId = sessionId;
        task.snapshot.sessionId = sessionId;

        if (sessionId !== null && !isTerminalStatus(task.snapshot.status)) {
            this.sessionActiveTaskIndex.set(sessionId, taskId);
        }
    }

    private finalizeTaskLifecycle(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        if (task.sessionId !== null) {
            const indexedTaskId = this.sessionActiveTaskIndex.get(task.sessionId);
            if (indexedTaskId === taskId) {
                this.sessionActiveTaskIndex.delete(task.sessionId);
            }
        }

        task.detachAbortRelay();
        this.scheduleTaskRelease(taskId);
    }

    /**
     * 终态任务保留一段时间，避免页面晚到订阅时直接丢失最后快照。
     */
    private scheduleTaskRelease(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task || task.releaseTimer !== null) {
            return;
        }

        task.releaseTimer = setTimeout(() => {
            this.releaseTask(taskId);
        }, TERMINAL_TASK_RETENTION_MS);
    }

    private releaseTask(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        if (task.releaseTimer !== null) {
            clearTimeout(task.releaseTimer);
            task.releaseTimer = null;
        }

        task.detachAbortRelay();
        if (task.sessionId !== null) {
            const indexedTaskId = this.sessionActiveTaskIndex.get(task.sessionId);
            if (indexedTaskId === taskId) {
                this.sessionActiveTaskIndex.delete(task.sessionId);
            }
        }

        this.tasks.delete(taskId);
    }

    private notifySubscribers(taskId: string): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        this.publishTaskStatusIfNeeded(task);

        for (const listener of task.subscribers) {
            try {
                listener(cloneTaskSnapshot(task.snapshot));
            } catch (error) {
                console.error('[SessionTaskCenter] Subscriber error:', error);
            }
        }
    }

    /**
     * 只在状态或所属会话发生变化时发布事件，避免流式 chunk 期间重复刷事件总线。
     */
    private publishTaskStatusIfNeeded(task: MutableSessionTask): void {
        if (task.sessionId === null) {
            return;
        }

        const sessionChanged = task.lastPublishedSessionId !== task.sessionId;
        const statusChanged = task.lastPublishedStatus !== task.snapshot.status;
        if (!sessionChanged && !statusChanged) {
            return;
        }

        const previousStatus = sessionChanged ? null : task.lastPublishedStatus;
        task.lastPublishedSessionId = task.sessionId;
        task.lastPublishedStatus = task.snapshot.status;

        void eventService.emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
            sessionId: task.sessionId,
            taskId: task.taskId,
            status: task.snapshot.status,
            previousStatus,
            reminder: buildSessionStatusReminder(task.snapshot),
        });
    }
}

export const sessionTaskCenter = new SessionTaskCenter();
