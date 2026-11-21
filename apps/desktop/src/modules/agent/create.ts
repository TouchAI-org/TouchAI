import type { AgentEvent } from '@touchai/agent-core/contracts';
import { AgentError } from '@touchai/agent-core/contracts';

import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

import { cloneInputHistorySnapshot } from './contracts/history';
import type { AgentSessionHost } from './contracts/host';
import type { AskUserAnswer, ToolApprovalDecisionRequest } from './contracts/presentation';
import type {
    StartedSessionTask,
    StartSessionTaskOptions,
    TaskModelSummary,
    TaskResult,
    TaskSnapshotListener,
    TaskViewSnapshot,
} from './contracts/task';
import { cloneTaskValue } from './contracts/task';
import { createPendingQueues, type PendingQueue } from './pending';
import { SessionTaskProjection } from './projection/create';
import { isTerminalStatus } from './projection/helpers';
import { NotificationCoalescer } from './projection/notifications';
import { cloneTaskViewSnapshot } from './projection/view';

interface TaskProjection {
    snapshot: TaskViewSnapshot;
    projection: SessionTaskProjection;
    subscribers: Set<TaskSnapshotListener>;
    completion: Promise<TaskResult>;
    detach(): void;
    attemptToken: string | null;
    cancelRequested: boolean;
    published: TaskViewSnapshot | null;
    releaseTimer?: ReturnType<typeof setTimeout>;
}

const RETENTION_MS = 5 * 60 * 1000;
const numericKey = (key: string | null, prefix: string): number | null => {
    const match = key?.match(new RegExp(`^${prefix}:([1-9][0-9]*)$`));
    const value = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(value) ? value : null;
};
const safeModel = (model: TaskModelSummary | null): TaskModelSummary | null =>
    model && {
        modelDbId: model.modelDbId,
        providerId: model.providerId,
        providerName: model.providerName,
        modelId: model.modelId,
        modelName: model.modelName,
    };

function approvalRequest(
    event: Extract<AgentEvent, { type: 'decision_required'; kind: 'approval' }>
): ToolApprovalDecisionRequest {
    const text = (key: string) =>
        typeof event.payload[key] === 'string' ? (event.payload[key] as string) : '';
    return {
        callId: event.callId,
        title: text('title'),
        description: text('description'),
        command: text('command'),
        riskLabel: text('riskLabel'),
        reason: text('reason'),
        commandLabel: text('commandLabel'),
        approveLabel: text('approveLabel'),
        rejectLabel: text('rejectLabel'),
        enterHint: text('enterHint'),
        escHint: text('escHint'),
        ...(typeof event.payload.keyboardApproveDelayMs === 'number'
            ? { keyboardApproveDelayMs: event.payload.keyboardApproveDelayMs }
            : {}),
    };
}

/** Desktop owns history and projections; Core alone owns active tasks, attempts, decisions and the loop. */
export function createAgentSessions(input: AgentSessionHost) {
    const execution = Object.freeze({
        start: input.execution.start.bind(input.execution),
        subscribe: input.execution.subscribe.bind(input.execution),
        cancel: input.execution.cancel.bind(input.execution),
        reply: input.execution.reply.bind(input.execution),
    });
    const beforeStart = input.beforeStart.bind(input);
    const loadHistory = input.loadHistory.bind(input);
    const describeModel = input.modelSummary.bind(input);
    const subscribePresentation = input.subscribePresentation.bind(input);
    const publishStatus = input.publishStatus?.bind(input);
    const observerError = input.reportObserverError?.bind(input);
    const messages = Object.freeze({
        tt: input.messages.tt.bind(input.messages),
        errorText: input.messages.errorText.bind(input.messages),
        retryText: input.messages.retryText.bind(input.messages),
    });
    const tools = Object.freeze({
        resolveSemantic: input.tools.resolveSemantic.bind(input.tools),
        presentation: input.tools.presentation.bind(input.tools),
        widgetToolName: input.tools.widgetToolName,
    });
    const tasks = new Map<string, TaskProjection>();
    const lifetime = new AbortController();
    let disposed = false;
    const report = (error: unknown) => {
        try {
            observerError?.(error);
        } catch {
            /* Passive observers cannot alter a task. */
        }
    };
    const currentView = (task: TaskProjection) => {
        const view = cloneTaskViewSnapshot(task.snapshot, task.published);
        task.published = view;
        return view;
    };
    const notifications = new NotificationCoalescer((taskId) => {
        const task = tasks.get(taskId);
        if (!task) return;
        const view = currentView(task);
        try {
            publishStatus?.(view);
        } catch (error) {
            report(error);
        }
        for (const listener of task.subscribers) {
            try {
                listener(view);
            } catch (error) {
                report(error);
            }
        }
    });
    const notify = (taskId: string) => {
        const task = tasks.get(taskId);
        if (!task) return;
        if (task.snapshot.status === 'running') notifications.schedule(taskId);
        else notifications.flushNow(taskId);
    };
    const release = (taskId: string) => {
        const task = tasks.get(taskId);
        if (!task) return;
        if (task.releaseTimer !== undefined) clearTimeout(task.releaseTimer);
        notifications.cancel(taskId);
        task.detach();
        task.subscribers.clear();
        tasks.delete(taskId);
        queues.release(taskId);
    };

    const queues = createPendingQueues({
        store: input.pendingMessages,
        snapshot: (taskId) => tasks.get(taskId)?.snapshot,
        changed: notify,
        delivered: (taskId, delivered) =>
            tasks.get(taskId)?.projection.syncTaskMetadata({
                type: 'user_messages_delivered',
                messages: delivered,
            }),
        rejected: (taskId, messageIds) =>
            tasks.get(taskId)?.projection.syncTaskMetadata({
                type: 'user_messages_rejected',
                messageIds,
            }),
        start: startTask,
        report,
    });

    const observe = (task: TaskProjection, event: AgentEvent) => {
        if (
            event.taskId !== task.snapshot.taskId ||
            disposed ||
            isTerminalStatus(task.snapshot.status)
        )
            return;
        const projection = task.projection;
        if (event.type === 'task_started') {
            const model = safeModel(describeModel(event.taskId, event.modelKey));
            if (!model) throw new AgentError('MODEL_BINDING_NOT_FOUND');
            projection.syncTaskMetadata({
                type: event.type,
                sessionId: numericKey(event.conversationKey, 'session'),
                turnId: numericKey(event.turnKey, 'turn'),
                model,
            });
            queues.bind(event.taskId, task.snapshot.sessionId);
        } else if (event.type === 'attempt_started') {
            task.attemptToken = event.attemptToken;
        } else if (event.type === 'attempt_finished') {
            if (event.attemptToken !== task.attemptToken) return;
            task.attemptToken = null;
            projection.clearPendingApprovals(messages.tt('请求已取消'));
        } else if (event.type === 'stream') {
            if (task.attemptToken !== event.attemptToken || task.cancelRequested) return;
            const chunk = event.chunk;
            projection.handleChunk({
                content: chunk.content,
                done: chunk.done,
                reasoning: chunk.reasoning,
                reasoningState: chunk.reasoningState,
                textState: chunk.textState,
                toolBoundary: !!(chunk.toolCalls?.length || chunk.toolCallDeltas?.length),
            });
        } else if (event.type === 'decision_required') {
            if (event.kind === 'approval') {
                const payload = approvalRequest(event);
                const display = projection.formatApproval(payload);
                display.decisionId = event.decisionId;
                projection.observeApproval(display, payload);
            } else
                projection.observeQuestion({
                    callId: event.callId,
                    decisionId: event.decisionId,
                    sourceMessageId: projection.getActiveAssistantMessageId() ?? '',
                    createdAt: Date.now(),
                    questions: event.payload.map((question) => ({
                        ...cloneTaskValue(question),
                        header: question.header ?? '',
                    })),
                });
        } else if (event.type === 'decision_resolved') {
            projection.observeResolution(
                event.decisionId,
                event.kind === 'approval' ? event.value === true : null,
                task.cancelRequested ? messages.tt('请求已取消') : undefined
            );
        } else if (event.type === 'checkpoint_committed')
            projection.syncTaskMetadata({ type: event.type });
        else if (event.type === 'retry_scheduled') {
            projection.handleChunk({
                content: '',
                done: false,
                toolEvent: {
                    type: 'request_retry',
                    attempt: event.attempt,
                    maxRetries: 5,
                    reason: event.errorCode,
                    retryScope: event.checkpoint.iteration > 0 ? 'checkpoint' : 'restart',
                    resumeFromIteration: event.checkpoint.iteration,
                    discardVisibleOutputSinceCheckpoint: event.discardOutput,
                    discardToolActivitySinceCheckpoint: event.discardToolActivity,
                },
            });
        } else if (event.type === 'model_switched')
            projection.syncModel(
                safeModel(describeModel(event.taskId, event.modelKey)),
                task.snapshot.modelSwitchCount + 1
            );
        else if (event.type === 'context_compaction')
            projection.handleChunk({
                content: '',
                done: false,
                contextCompaction: { id: event.id, state: event.state },
            });
        else if (event.type === 'task_completed') {
            const model =
                safeModel(describeModel(event.taskId, event.result.modelKey)) ??
                task.snapshot.currentModel;
            if (!model) throw new AgentError('MODEL_BINDING_NOT_FOUND');
            projection.syncTaskMetadata({
                type: event.type,
                turnId: numericKey(event.result.turnKey, 'turn'),
                model,
            });
        } else if (event.type === 'task_failed') {
            queues.restoreUncommitted(event.taskId);
            projection.syncTaskMetadata({
                type: event.type,
                turnId: task.snapshot.turnId,
                error: event.errorCode,
            });
        } else if (event.type === 'task_cancelled') {
            queues.restoreUncommitted(event.taskId);
            projection.syncTaskMetadata({ type: event.type, turnId: task.snapshot.turnId });
        }
    };

    async function startTask(
        request: StartSessionTaskOptions,
        inherited?: PendingQueue
    ): Promise<StartedSessionTask> {
        if (disposed) throw new AgentError('AGENT_DISPOSED');
        const queue = queues.begin(request, inherited);
        try {
            return await startPreparedTask(request, queue);
        } catch (error) {
            queues.rollback(queue);
            throw error;
        }
    }

    async function startPreparedTask(
        request: StartSessionTaskOptions,
        queue: PendingQueue
    ): Promise<StartedSessionTask> {
        if (disposed) throw new AgentError('AGENT_DISPOSED');
        const options = {
            ...request,
            attachments: request.attachments ? cloneTaskValue(request.attachments) : undefined,
            inputSnapshot: cloneInputHistorySnapshot(request.inputSnapshot) ?? undefined,
        };
        const combined = combineAbortSignals([
            options.signal,
            lifetime.signal,
            queue.starting?.controller.signal,
        ]);
        const { signal } = combined;
        let history: Awaited<ReturnType<typeof loadHistory>>;
        try {
            try {
                await awaitAbortable(beforeStart, signal);
                signal.throwIfAborted();
            } catch (cause) {
                if (signal.aborted)
                    throw new AgentError(disposed ? 'AGENT_DISPOSED' : 'REQUEST_CANCELLED', false, {
                        cause,
                    });
                throw cause;
            }
            try {
                history =
                    options.sessionId === undefined
                        ? []
                        : await awaitAbortable(() => loadHistory(options.sessionId!), signal);
                signal.throwIfAborted();
            } catch (cause) {
                if (signal.aborted)
                    throw new AgentError(disposed ? 'AGENT_DISPOSED' : 'REQUEST_CANCELLED', false, {
                        cause,
                    });
                if (cause instanceof AgentError) throw cause;
                throw new AgentError('PERSISTENCE_FAILED', false, { cause });
            }
        } catch (error) {
            combined.dispose();
            throw error;
        }
        let started: ReturnType<typeof execution.start>;
        try {
            if (disposed) throw new AgentError('AGENT_DISPOSED');
            started = execution.start({ ...options, signal }, queues.delivery(queue));
        } catch (error) {
            combined.dispose();
            throw error;
        }
        const snapshot: TaskViewSnapshot = {
            taskId: started.taskId,
            sessionId: options.sessionId ?? null,
            turnId: null,
            status: 'running',
            executionMode: options.executionMode ?? 'foreground',
            sessionHistory: [],
            pendingUserMessages: cloneTaskValue(queue.messages),
            pendingApprovals: [],
            pendingToolApproval: null,
            pendingUserQuestion: null,
            error: null,
            currentModel: null,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            modelSwitchCount: 0,
        };
        const projection = new SessionTaskProjection(
            snapshot,
            () => notify(started.taskId),
            messages,
            tools,
            (append) => input.onTextAppended?.(started.taskId, append)
        );
        const cleanups = new Set<() => void>();
        const completion = started.completion
            .then((result): TaskResult => {
                const model = safeModel(snapshot.currentModel);
                if (!model) throw new AgentError('MODEL_BINDING_NOT_FOUND');
                return {
                    model,
                    response: result.response,
                    reasoning: result.reasoning,
                    turn:
                        snapshot.turnId === null
                            ? null
                            : {
                                  id: snapshot.turnId,
                                  sessionId: snapshot.sessionId,
                                  status: 'completed',
                              },
                };
            })
            .finally(async () => {
                combined.dispose();
                const task = tasks.get(started.taskId);
                if (!task) return;
                task.detach();
                await queues.settled(started.taskId);
                if (!disposed)
                    task.releaseTimer = setTimeout(() => release(started.taskId), RETENTION_MS);
            });
        const task: TaskProjection = {
            snapshot,
            projection,
            subscribers: new Set(),
            attemptToken: null,
            cancelRequested: false,
            published: null,
            completion,
            detach: () => {
                for (const cleanup of cleanups) {
                    try {
                        cleanup();
                    } catch (error) {
                        report(error);
                    }
                }
                cleanups.clear();
            },
        };
        tasks.set(started.taskId, task);
        queues.attach(started.taskId, queue);
        void task.completion.catch(() => undefined);
        try {
            projection.bootstrap(
                history,
                options.prompt,
                options.attachments,
                options.inputSnapshot,
                options.userMessageId
            );
            cleanups.add(
                execution.subscribe(started.taskId, (event) => {
                    try {
                        observe(task, event);
                    } catch (error) {
                        report(error);
                    }
                })
            );
            cleanups.add(
                subscribePresentation(started.taskId, (chunk, attemptToken) => {
                    if (
                        !disposed &&
                        !task.cancelRequested &&
                        task.attemptToken === attemptToken &&
                        !isTerminalStatus(snapshot.status)
                    ) {
                        projection.handleChunk(chunk);
                    }
                })
            );
        } catch (error) {
            task.cancelRequested = true;
            execution.cancel(started.taskId);
            release(started.taskId);
            await Promise.allSettled([completion]);
            throw error;
        }
        return {
            taskId: started.taskId,
            sessionId: snapshot.sessionId,
            completion: task.completion,
        };
    }

    const resolveApproval = (
        taskId: string,
        callId: string | undefined,
        decisionId: string | undefined,
        value: boolean
    ) => {
        const task = tasks.get(taskId);
        const display =
            callId === undefined
                ? task?.snapshot.pendingToolApproval
                : task?.snapshot.pendingApprovals.find(
                      (approval) => approval.callId === callId && approval.decisionId === decisionId
                  );
        if (!display?.decisionId || (callId !== undefined && !decisionId)) return false;
        return execution.reply({ taskId, decisionId: display.decisionId, value });
    };

    return Object.freeze({
        ...queues.commands,
        startTask,
        startForegroundTask: (options: StartSessionTaskOptions) =>
            startTask({ ...options, executionMode: options.executionMode ?? 'foreground' }),
        startBackgroundTask: (options: StartSessionTaskOptions) =>
            startTask({ ...options, executionMode: 'background' }),
        cancelTask(taskId: string, options: { preservePending?: boolean } = {}): boolean {
            const task = tasks.get(taskId);
            if (!task) return false;
            if (options.preservePending === false) queues.commands.clearTaskUserMessages(taskId);
            task.cancelRequested = true;
            const accepted = execution.cancel(taskId);
            if (!accepted) task.cancelRequested = false;
            return accepted;
        },
        approveTaskToolCall: (taskId: string, callId?: string, decisionId?: string) =>
            resolveApproval(taskId, callId, decisionId, true),
        rejectTaskToolCall: (taskId: string, callId?: string, decisionId?: string) =>
            resolveApproval(taskId, callId, decisionId, false),
        settleTaskUserQuestion(
            taskId: string,
            callId: string,
            answers: AskUserAnswer[] | null,
            decisionId?: string
        ): boolean {
            const current = tasks.get(taskId)?.snapshot.pendingUserQuestion;
            return (
                !!decisionId &&
                current?.callId === callId &&
                current.decisionId === decisionId &&
                execution.reply({ taskId, decisionId, value: answers })
            );
        },
        attachSessionView(sessionId: number) {
            const task = [...tasks.values()].find(
                (task) =>
                    task.snapshot.sessionId === sessionId && !isTerminalStatus(task.snapshot.status)
            );
            return task ? { taskId: task.snapshot.taskId, snapshot: currentView(task) } : null;
        },
        getTaskSnapshot(taskId: string): TaskViewSnapshot | null {
            const task = tasks.get(taskId);
            return task ? currentView(task) : null;
        },
        subscribeTask(taskId: string, listener: TaskSnapshotListener): () => void {
            const task = tasks.get(taskId);
            if (!task) throw new AgentError('TASK_NOT_FOUND');
            task.subscribers.add(listener);
            try {
                listener(currentView(task));
            } catch (error) {
                task.subscribers.delete(listener);
                throw error;
            }
            return () => {
                task.subscribers.delete(listener);
            };
        },
        unsubscribeTask(taskId: string, listener: TaskSnapshotListener) {
            tasks.get(taskId)?.subscribers.delete(listener);
        },
        getSessionStatus(sessionId: number) {
            const task = [...tasks.values()].find(
                (task) =>
                    task.snapshot.sessionId === sessionId && !isTerminalStatus(task.snapshot.status)
            );
            return task ? { status: task.snapshot.status, taskId: task.snapshot.taskId } : null;
        },
        listActiveTasks: () =>
            [...tasks.values()]
                .filter((task) => !isTerminalStatus(task.snapshot.status))
                .map(currentView),
        async dispose() {
            if (disposed) return;
            disposed = true;
            lifetime.abort();
            queues.dispose();
            for (const taskId of tasks.keys()) execution.cancel(taskId);
            await Promise.allSettled([...tasks.values()].map((task) => task.completion));
            notifications.dispose();
            for (const taskId of tasks.keys()) release(taskId);
        },
    });
}

export type AgentSessions = ReturnType<typeof createAgentSessions>;
