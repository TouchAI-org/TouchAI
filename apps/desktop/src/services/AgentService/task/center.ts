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
    lastPublishedReminderKey: string | null;
}

const TERMINAL_TASK_RETENTION_MS = 5 * 60 * 1000;
const STATUS_REMINDER_MAX_BODY_CHARS = 220;
const STATUS_REMINDER_MAX_COMMAND_CHARS = 160;

/** 深拷贝任务快照，确保外部订阅者无法直接修改内部状态。 */
function cloneTaskSnapshot(snapshot: SessionTaskSnapshot): SessionTaskSnapshot {
    return cloneTaskValue(snapshot);
}

/**
 * 将 reminder 质量化为稳定字符串键，用于变更检测。
 * 包含 kind、title、body 和 approvalCallId，确保任何字段变化都能触发重新发布。
 */
function getReminderPublishKey(reminder: SessionStatusReminderPayload | null): string | null {
    if (!reminder) {
        return null;
    }

    return JSON.stringify({
        kind: reminder.kind,
        title: reminder.title,
        body: reminder.body,
        approvalCallId: reminder.approval?.callId ?? null,
    });
}

/** 判断任务是否已进入终态（完成、失败或已取消）。 */
function isTerminalStatus(status: SessionTaskSnapshot['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** 将文本截断到指定字符数，超出部分以省略号结尾。 */
function truncateReminderText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
        return value;
    }

    return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/** 规范化空白并截断文本，空字符串返回 null。 */
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

/** 从会话历史中提取最后一条 assistant 消息的摘要。 */
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

/** 为等待审批状态构建通知正文，包含摘要和命令预览。 */
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

function buildWaitingUserQuestionBody(
    question: NonNullable<SessionTaskSnapshot['pendingUserQuestion']>
): string {
    return summarizeReminderText(question.questions[0]?.question) ?? tt('任务正在等待用户回复');
}

/**
 * 根据任务快照构建状态提醒负载。
 * 仅在 completed、failed、waiting_approval 三种状态下生成提醒，其余返回 null。
 */
export function buildSessionStatusReminder(
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
            replyPlaceholder: tt('回复 TouchAI'),
            replyLabel: tt('回复'),
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
        },
    };
}

/** 将外部 AbortSignal 的取消事件中继到内部 AbortController，返回清理函数。 */
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

    /**
     * 注册并启动一个新的会话任务。
     * 加载历史记录、创建运行时并开始执行，返回任务 ID 和完成 Promise。
     */
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
            pendingUserQuestion: null,
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
            lastPublishedReminderKey: null,
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
                requestUserQuestions: (callId, questions) => {
                    return projection.requestUserQuestions(callId, questions);
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

    /** 取消指定任务，中止其 AbortController 并清除待审批项。 */
    cancelTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        task.abortController.abort();
        task.projection.clearPendingApprovals(tt('请求已取消'));
        return true;
    }

    /** 批准任务中指定的工具调用（按 callId 匹配，不传则批准第一个）。 */
    approveTaskToolCall(taskId: string, callId?: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        return task.projection.approvePendingToolApproval(callId);
    }

    /** 拒绝任务中指定的工具调用（按 callId 匹配，不传则拒绝第一个）。 */
    rejectTaskToolCall(taskId: string, callId?: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        return task.projection.rejectPendingToolApproval(callId);
    }

    settleTaskUserQuestion(
        taskId: string,
        callId: string,
        answers: import('../contracts/tooling').AskUserAnswer[] | null
    ): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        return task.projection.settleUserQuestion(callId, answers);
    }

    /**
     * 将页面层绑定到指定会话的活跃任务，返回任务 ID 和当前快照的只读副本。
     * 若该会话没有活跃任务则返回 null。
     */
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

    /** 订阅任务快照变更，立即推送当前快照，返回取消订阅函数。 */
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

    /** 取消订阅任务快照变更。 */
    unsubscribeTask(taskId: string, listener: TaskSnapshotListener): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        task.subscribers.delete(listener);
    }

    /** 获取指定任务当前快照的只读副本，任务不存在则返回 null。 */
    getTaskSnapshot(taskId: string): SessionTaskSnapshot | null {
        const task = this.tasks.get(taskId);
        return task ? cloneTaskSnapshot(task.snapshot) : null;
    }

    /** 查询指定会话当前绑定的任务状态，无活跃任务则返回 null。 */
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

    /** 列出所有非终态的活跃任务快照。 */
    listActiveTasks(): SessionTaskSnapshot[] {
        return Array.from(this.tasks.values())
            .filter((task) => !isTerminalStatus(task.snapshot.status))
            .map((task) => cloneTaskSnapshot(task.snapshot));
    }

    /** 执行任务运行时，处理完成/取消/失败的终态转换。 */
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

    /** 确保指定会话没有正在运行的任务，否则抛出 SESSION_ACTIVE_TASK_EXISTS 错误。 */
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

    /** 处理运行时发出的回合事件，同步会话绑定和终态生命周期。 */
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

    /** 将任务绑定到指定会话，更新双向索引。 */
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

    /** 任务进入终态后清理会话索引、断开信号中继并安排延迟释放。 */
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

    /** 立即释放任务资源，从内存中移除任务及其会话索引。 */
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

    /** 向所有订阅者推送任务快照的只读副本，并在需要时发布状态事件。 */
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

        const reminder = buildSessionStatusReminder(task.snapshot);
        const sessionChanged = task.lastPublishedSessionId !== task.sessionId;
        const statusChanged = task.lastPublishedStatus !== task.snapshot.status;
        const reminderKey = getReminderPublishKey(reminder);
        const reminderChanged = task.lastPublishedReminderKey !== reminderKey;
        if (!sessionChanged && !statusChanged && !reminderChanged) {
            return;
        }

        const previousStatus = sessionChanged ? null : task.lastPublishedStatus;
        task.lastPublishedSessionId = task.sessionId;
        task.lastPublishedStatus = task.snapshot.status;
        task.lastPublishedReminderKey = reminderKey;

        void eventService.emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
            sessionId: task.sessionId,
            taskId: task.taskId,
            status: task.snapshot.status,
            previousStatus,
            reminder,
        });
    }
}

export const sessionTaskCenter = new SessionTaskCenter();
