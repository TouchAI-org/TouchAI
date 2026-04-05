// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { AiError, AiErrorCode } from '../contracts/errors';
import type { ConversationRuntimeEnvironment, TurnEvent } from '../execution';
import { AiRequestExecutor } from '../execution/executor';
import { AiConversationRuntime, type ExecuteRequestResult } from '../execution/runtime';
import { resolveMcpMaxIterations } from '../infrastructure/settings';
import { reportRuntimePersistenceIssue } from '../outputs';
import { loadSessionHistory } from '../session/history';
import { SessionTaskProjection } from './projection';
import type {
    SessionTaskSnapshot,
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
}

const TERMINAL_TASK_RETENTION_MS = 5 * 60 * 1000;

function cloneTaskSnapshot(snapshot: SessionTaskSnapshot): SessionTaskSnapshot {
    return cloneTaskValue(snapshot);
}

function isTerminalStatus(status: SessionTaskSnapshot['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
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
        maxIterations: await resolveMcpMaxIterations(),
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

            projection.bootstrap(historyResult.value, options.prompt, options.attachments);

            const runtime = new AiConversationRuntime(this.executor, {
                taskId,
                prompt: options.prompt,
                sessionId: options.sessionId,
                modelId: options.modelId,
                providerId: options.providerId,
                attachments: options.attachments,
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
        task.projection.clearPendingApprovals('任务已取消');
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
                    task.projection.markFailed(aiError.message);
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

        throw new AiError(
            AiErrorCode.SESSION_ACTIVE_TASK_EXISTS,
            { sessionId, activeTaskId: existingTaskId },
            '当前会话已有正在运行的任务，请等待完成、先取消，或切换到其他会话'
        );
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

        for (const listener of task.subscribers) {
            try {
                listener(cloneTaskSnapshot(task.snapshot));
            } catch (error) {
                console.error('[SessionTaskCenter] Subscriber error:', error);
            }
        }
    }
}

export const sessionTaskCenter = new SessionTaskCenter();
