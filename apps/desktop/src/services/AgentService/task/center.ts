// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { computerUseService } from '@services/ComputerUseService';
import { log } from '@services/ObservabilityService';

import { tt } from '@/i18n';
import { eventService } from '@/services/EventService';
import { AppEvent, type SessionStatusReminderPayload } from '@/services/EventService/types';
import { waitForAgentStartupCapabilities } from '@/services/StartupService/capabilities';
import { createPerfTrace } from '@/utils/perfTrace';
import {
    buildWaitingApprovalBody,
    buildWaitingUserQuestionBody,
    previewNotificationText,
    summarizeLatestAssistantResponse,
} from '@/utils/reminderText';
import { getSessionStatusReminderContent } from '@/utils/session';

import { AiError, AiErrorCode } from '../contracts/errors';
import type { TaskResult } from '../contracts/task';
import type {
    AskUserAnswer,
    AskUserQuestion,
    ToolApprovalDecisionRequest,
} from '../contracts/tooling';
import type { ConversationRuntimeEnvironment } from '../execution';
import { AiRequestExecutor } from '../execution/executor';
import { AiConversationRuntime, type RuntimeTurnEvent } from '../execution/runtime';
import { reportRuntimePersistenceIssue } from '../outputs';
import { loadSessionHistory } from '../session/history';
import { TaskInteractions } from './interactions';
import { NotificationCoalescer } from './notificationCoalescer';
import { SessionTaskProjection } from './projection';
import type {
    SessionTaskStatus,
    StartedSessionTask,
    StartSessionTaskOptions,
    TaskSnapshotListener,
    TaskViewSnapshot,
} from './types';
import { cloneTaskViewSnapshot } from './viewSnapshot';

interface MutableSessionTask {
    taskId: string;
    sessionId: number | null;
    subscribers: Set<TaskSnapshotListener>;
    snapshot: TaskViewSnapshot;
    abortController: AbortController;
    detachAbortRelay: () => void;
    interactions: TaskInteractions;
    projection: SessionTaskProjection;
    completion: Promise<TaskResult> | null;
    releaseTimer: ReturnType<typeof setTimeout> | null;
    lastPublishedStatus: SessionTaskStatus | null;
    lastPublishedSessionId: number | null;
    lastPublishedReminderKey: string | null;
    /** 上次发布给订阅者的展示快照，用于复用未变消息的对象引用。 */
    publishedView: TaskViewSnapshot | null;
}

const TERMINAL_TASK_RETENTION_MS = 5 * 60 * 1000;

export { cloneTaskViewSnapshot } from './viewSnapshot';

export function shouldPublishTaskSnapshotImmediately(snapshot: TaskViewSnapshot): boolean {
    return (
        snapshot.status !== 'running' ||
        snapshot.pendingToolApproval !== null ||
        snapshot.pendingUserQuestion !== null ||
        snapshot.pendingApprovals.length > 0
    );
}

export function createTaskPublishScheduler(notify: (taskId: string) => void): {
    schedule: (taskId: string, snapshot: TaskViewSnapshot) => void;
} {
    const pendingTaskIds = new Set<string>();
    let flushScheduled = false;

    return {
        schedule(taskId: string, snapshot: TaskViewSnapshot): void {
            if (shouldPublishTaskSnapshotImmediately(snapshot)) {
                pendingTaskIds.delete(taskId);
                notify(taskId);
                return;
            }

            pendingTaskIds.add(taskId);
            if (flushScheduled) {
                return;
            }

            flushScheduled = true;
            queueMicrotask(() => {
                flushScheduled = false;
                const dirtyTaskIds = Array.from(pendingTaskIds);
                pendingTaskIds.clear();
                for (const dirtyTaskId of dirtyTaskIds) {
                    notify(dirtyTaskId);
                }
            });
        },
    };
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
        approvalDecisionId: reminder.approval?.decisionId ?? null,
    });
}

/** 判断任务是否已进入终态（完成、失败或已取消）。 */
function isTerminalStatus(status: TaskViewSnapshot['status']): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}

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
export class SessionTaskCenter {
    private readonly tasks = new Map<string, MutableSessionTask>();
    private readonly sessionActiveTaskIndex = new Map<number, string>();
    private readonly executor = new AiRequestExecutor();
    /** Coalesces high-frequency streaming snapshots; terminal/error paths flush now. */
    private readonly notificationCoalescer = new NotificationCoalescer((taskId) =>
        this.flushTaskNotifications(taskId)
    );

    /**
     * 注册并启动一个新的会话任务。
     * 加载历史记录、创建运行时并开始执行，返回任务 ID 和完成 Promise。
     */
    async startTask(options: StartSessionTaskOptions): Promise<StartedSessionTask> {
        this.ensureSessionSlotAvailable(options.sessionId ?? null);

        // 只等待请求实际依赖的后台能力；启动阶段不 await 这些任务。
        await waitForAgentStartupCapabilities();
        this.ensureSessionSlotAvailable(options.sessionId ?? null);

        const taskId = crypto.randomUUID();
        const abortController = new AbortController();
        const detachAbortRelay = relayAbortSignal(options.signal, abortController);
        const snapshot: TaskViewSnapshot = {
            taskId,
            sessionId: options.sessionId ?? null,
            turnId: null,
            status: 'running',
            executionMode: options.executionMode ?? 'foreground',
            sessionHistory: [],
            pendingToolApproval: null,
            pendingApprovals: [],
            pendingUserQuestion: null,
            error: null,
            currentModel: null,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            modelSwitchCount: 0,
        };
        const interactions = new TaskInteractions(taskId);
        const projection = new SessionTaskProjection(
            snapshot,
            () => {
                this.notifySubscribers(taskId);
            },
            interactions
        );
        const task: MutableSessionTask = {
            taskId,
            sessionId: options.sessionId ?? null,
            subscribers: new Set(),
            snapshot,
            abortController,
            detachAbortRelay,
            interactions,
            projection,
            completion: null,
            releaseTimer: null,
            lastPublishedStatus: null,
            lastPublishedSessionId: null,
            lastPublishedReminderKey: null,
            publishedView: null,
        };

        this.tasks.set(taskId, task);
        computerUseService.bindTask(abortController.signal, () => this.cancelTask(taskId));
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
                log.error(
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
                    return this.requestTaskToolApproval(task, payload);
                },
                requestUserQuestions: (callId, questions, attemptToken) => {
                    return this.requestTaskUserQuestions(task, callId, questions, attemptToken);
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
        // Cancellation is decisive: clearing pending cards must reach subscribers now,
        // not on the next coalesced tick.
        this.notificationCoalescer.flushNow(taskId);
        return true;
    }

    /**
     * 批准任务中指定的工具调用（按 callId 匹配，不传则批准第一个）。
     *
     * 显式 callId 的决定必须携带捕获到的 `decisionId`：缺失或过期一律 fail closed。
     * 无 callId 的即时动作（键盘快捷）才从当前快照捕获 `{callId, decisionId}`。
     */
    approveTaskToolCall(taskId: string, callId?: string, decisionId?: string): boolean {
        return this.resolveTaskToolApproval(taskId, callId, decisionId, true);
    }

    /** 拒绝任务中指定的工具调用（按 callId 匹配，不传则拒绝第一个）。 */
    rejectTaskToolCall(taskId: string, callId?: string, decisionId?: string): boolean {
        return this.resolveTaskToolApproval(taskId, callId, decisionId, false);
    }

    settleTaskUserQuestion(
        taskId: string,
        callId: string,
        answers: AskUserAnswer[] | null,
        decisionId?: string
    ): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        // Fail closed: an explicit callId must carry the captured identity, never a
        // freshly backfilled one.
        return task.projection.settleInteractionQuestion(callId, answers, decisionId);
    }

    /**
     * 登记一次审批等待并把卡片呈现出来。
     *
     * 登记与 Promise 生命周期归 `TaskInteractions`：即使当前没有可见的 assistant
     * 消息，也会先登记 resolver 再发布，保证运行时等待不依赖 UI 是否就绪。
     */
    private requestTaskToolApproval(
        task: MutableSessionTask,
        payload: ToolApprovalDecisionRequest
    ): Promise<boolean> {
        // A late callback from a superseded/ended attempt must not register nor
        // render a ghost card: bail out before formatting.
        if (!task.interactions.acceptsRegistration(payload.attemptToken)) {
            return Promise.resolve(false);
        }

        const display = task.projection.formatApproval(payload);
        const promise = task.interactions.registerApproval(display, payload.attemptToken);
        task.projection.renderApproval(display, payload);
        return promise;
    }

    /** 登记一次结构化提问等待并发布展示状态。 */
    private requestTaskUserQuestions(
        task: MutableSessionTask,
        callId: string,
        questions: AskUserQuestion[],
        attemptToken?: string
    ): Promise<AskUserAnswer[] | null> {
        if (!task.interactions.acceptsRegistration(attemptToken)) {
            return Promise.resolve(null);
        }

        const record = {
            callId,
            sourceMessageId: task.projection.getActiveAssistantMessageId() ?? '',
            questions,
            createdAt: Date.now(),
        };
        const promise = task.interactions.registerQuestion(record, attemptToken);
        task.projection.renderQuestion(record);
        return promise;
    }

    private resolveTaskToolApproval(
        taskId: string,
        callId: string | undefined,
        decisionId: string | undefined,
        approved: boolean
    ): boolean {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }

        // An explicit callId without a captured identity is refused: never backfill
        // the current token onto a stale decision (e.g. an old OS notification).
        if (callId !== undefined) {
            if (!decisionId) {
                return false;
            }
            return task.projection.settleInteractionApproval(callId, approved, { decisionId });
        }

        // No callId is the immediate keyboard action: capture the current wait's identity.
        const current = task.interactions.pendingApproval;
        if (!current?.decisionId) {
            return false;
        }
        return task.projection.settleInteractionApproval(current.callId, approved, {
            decisionId: current.decisionId,
        });
    }

    /**
     * 将页面层绑定到指定会话的活跃任务，返回任务 ID 和当前快照的只读副本。
     * 若该会话没有活跃任务则返回 null。
     */
    attachSessionView(sessionId: number): { taskId: string; snapshot: TaskViewSnapshot } | null {
        const taskId = this.sessionActiveTaskIndex.get(sessionId);
        if (!taskId) {
            return null;
        }

        const task = this.tasks.get(taskId);
        if (!task) {
            this.sessionActiveTaskIndex.delete(sessionId);
            return null;
        }

        const view = cloneTaskViewSnapshot(task.snapshot, task.publishedView);
        task.publishedView = view;
        return { taskId, snapshot: view };
    }

    /** 订阅任务快照变更，立即推送当前快照，返回取消订阅函数。 */
    subscribeTask(taskId: string, listener: TaskSnapshotListener): () => void {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new AiError(AiErrorCode.TASK_NOT_FOUND, { taskId });
        }

        task.subscribers.add(listener);
        const view = cloneTaskViewSnapshot(task.snapshot, task.publishedView);
        task.publishedView = view;
        listener(view);

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
    getTaskSnapshot(taskId: string): TaskViewSnapshot | null {
        const task = this.tasks.get(taskId);
        if (!task) {
            return null;
        }

        const view = cloneTaskViewSnapshot(task.snapshot, task.publishedView);
        task.publishedView = view;
        return view;
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
    listActiveTasks(): TaskViewSnapshot[] {
        return Array.from(this.tasks.values())
            .filter((task) => !isTerminalStatus(task.snapshot.status))
            .map((task) => {
                const view = cloneTaskViewSnapshot(task.snapshot, task.publishedView);
                task.publishedView = view;
                return view;
            });
    }

    /**
     * 释放进程级中心持有的定时器：合并通知、终态保留。仅用于测试或应用退出。
     */
    dispose(): void {
        this.notificationCoalescer.dispose();
        for (const task of this.tasks.values()) {
            if (task.releaseTimer !== null) {
                clearTimeout(task.releaseTimer);
                task.releaseTimer = null;
            }
            // 走每个任务的取消路径，让运行中的请求停止、等待项被结算、信号中继断开，
            // 而不是把仍持有 Promise 的任务直接从内存里抹掉。
            task.abortController.abort();
            task.detachAbortRelay();
            task.interactions.cancelAll();
        }
        this.tasks.clear();
        this.sessionActiveTaskIndex.clear();
    }

    /** 执行任务运行时，处理完成/取消/失败的终态转换。 */
    private async runTask(taskId: string, runtime: AiConversationRuntime): Promise<TaskResult> {
        try {
            return await runtime.run();
        } catch (error) {
            const task = this.tasks.get(taskId);
            if (task && !isTerminalStatus(task.snapshot.status)) {
                const aiError = AiError.fromError(error);
                if (aiError.is(AiErrorCode.REQUEST_CANCELLED)) {
                    task.projection.markCancelled();
                } else {
                    task.projection.markFailed(aiError.getDisplayMessage());
                }
                this.finalizeTaskLifecycle(taskId);
            }
            throw error;
        } finally {
            const task = this.tasks.get(taskId);
            if (task) {
                await computerUseService.endActivity(task.abortController.signal).catch((error) => {
                    log.warn('[SessionTaskCenter] Failed to release computer-use feedback:', error);
                });
            }
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
    private handleTaskEvent(taskId: string, event: RuntimeTurnEvent): void {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        if (event.type === 'task_started') {
            this.bindTaskToSession(taskId, event.sessionId);
            return;
        }

        if (event.type === 'attempt_started') {
            // 新 attempt 的交互 scope：释放上一代等待项，并用运行时给出的
            // attempt token 关闭旧代登记入口（迟到的旧回调会被拒绝）。
            task.projection.syncInteractionRelease(
                task.interactions.beginAttempt(event.attemptToken),
                tt('请求已取消')
            );
            return;
        }

        if (event.type === 'attempt_finished') {
            // attempt 结束到下一次 attempt 开始之间（重试延迟/终态处理）不再
            // 接受该 attempt 的迟到登记，同时把它的等待项同步释放到投影。
            task.projection.syncInteractionRelease(
                task.interactions.endAttempt(),
                tt('请求已取消')
            );
            return;
        }

        if (event.type === 'retry_scheduled') {
            // 状态同步由投影负责；交互释放统一走 attempt_started，避免把
            // retry 计数当成 interaction generation。
            return;
        }

        if (
            event.type === 'task_completed' ||
            event.type === 'task_failed' ||
            event.type === 'task_cancelled'
        ) {
            task.projection.syncInteractionRelease(task.interactions.cancelAll(), tt('请求已取消'));
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

        // 释放任务时确保没有遗留的等待项悬挂。
        task.interactions.cancelAll();
        this.notificationCoalescer.cancel(taskId);
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

        // Streaming updates are coalesced to one notification per tick; approval,
        // terminal and error states flush immediately so the UI never misses them.
        if (task.snapshot.status !== 'running') {
            this.notificationCoalescer.flushNow(taskId);
            return;
        }

        this.notificationCoalescer.schedule(taskId);
    }

    /** 立即推送某个任务的快照，并清除它待合并的通知。 */
    private flushTaskNotifications(taskId: string): void {
        this.notificationCoalescer.cancel(taskId);

        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }

        this.publishTaskStatusIfNeeded(task);

        const trace = createPerfTrace('task.publish');
        const view = cloneTaskViewSnapshot(task.snapshot, task.publishedView);
        task.publishedView = view;

        for (const listener of task.subscribers) {
            try {
                listener(view);
            } catch (error) {
                log.error('[SessionTaskCenter] Subscriber error:', error);
            }
        }

        trace.end({ messages: task.snapshot.sessionHistory.length });
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

        // Fire-and-forget: EventService already logs the failure, so swallow the
        // rejection here to avoid an unhandled rejection (e.g. no Tauri host).
        void eventService
            .emit(AppEvent.SESSION_TASK_STATUS_CHANGED, {
                sessionId: task.sessionId,
                taskId: task.taskId,
                status: task.snapshot.status,
                previousStatus,
                reminder,
            })
            .catch(() => {});
    }
}

export const sessionTaskCenter = new SessionTaskCenter();
