import { snapshotValue } from './checkpoints/snapshot';
import { ContextWindow } from './context/window';
import type { AgentEvent, AgentHost, AgentResult, AgentStartInput, AgentView } from './contracts';
import { AgentError } from './contracts/agent';
import { TurnExecution } from './execution/turn';
import { TaskDecisions } from './task/decisions';

interface Task {
    view: AgentView;
    conversationKeys: Set<string>;
    controller: AbortController;
    decisions: TaskDecisions;
    listeners: Set<(event: AgentEvent) => void>;
    completion: Promise<AgentResult>;
    terminal?: AgentEvent;
    retention?: ReturnType<typeof setTimeout>;
    detach(): void;
}

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

export function createAgent(input: AgentHost) {
    const host: AgentHost = Object.freeze({
        prepareTurn: input.prepareTurn.bind(input),
        persistence: input.persistence.bind(input),
    });
    const tasks = new Map<string, Task>();
    const conversations = new Map<string, string>();
    const context = new ContextWindow();
    const cacheKey = crypto.randomUUID();
    let disposed = false;
    const publish = (taskId: string, event: AgentEvent) => {
        const task = tasks.get(taskId);
        if (!task) return;
        if (event.type === 'task_started') {
            if (event.conversationKey) {
                const occupied = conversations.get(event.conversationKey);
                if (occupied && occupied !== taskId)
                    throw new AgentError('SESSION_ACTIVE_TASK_EXISTS');
            }
            if (event.conversationKey) {
                conversations.set(event.conversationKey, taskId);
                task.conversationKeys.add(event.conversationKey);
            }
            task.view = {
                ...task.view,
                conversationKey: event.conversationKey,
                turnKey: event.turnKey,
                modelKey: event.modelKey,
            };
        }
        if (event.type === 'attempt_started') task.view.attempt = event.attempt;
        if (event.type === 'model_switched') task.view.modelKey = event.modelKey;
        if (event.type === 'decision_required' || event.type === 'decision_resolved') {
            const pending = task.decisions.pending;
            task.view.status = pending.some((decision) => decision.kind === 'approval')
                ? 'waiting_approval'
                : pending.length
                  ? 'waiting_question'
                  : 'running';
        }
        const observation = snapshotValue(event);
        for (const listener of task.listeners) {
            try {
                listener(observation);
            } catch {
                /* Observers cannot change execution or persistence. */
            }
        }
    };
    const release = (taskId: string) => {
        const task = tasks.get(taskId);
        if (!task) return;
        if (task.retention !== undefined) clearTimeout(task.retention);
        task.detach();
        task.decisions.close();
        task.listeners.clear();
        tasks.delete(taskId);
    };
    return Object.freeze({
        start(request: AgentStartInput) {
            if (disposed) throw new AgentError('AGENT_DISPOSED');
            if (request.conversationKey && conversations.has(request.conversationKey))
                throw new AgentError('SESSION_ACTIVE_TASK_EXISTS');
            const taskId = crypto.randomUUID();
            const controller = new AbortController();
            const abort = () => controller.abort();
            if (request.signal?.aborted) abort();
            else request.signal?.addEventListener('abort', abort, { once: true });
            const decisions = new TaskDecisions(taskId, (event) => publish(taskId, event));
            controller.signal.addEventListener('abort', () => decisions.close(), { once: true });
            const frozen = { ...request, signal: controller.signal };
            const execution = new TurnExecution(
                host,
                frozen,
                taskId,
                controller.signal,
                decisions,
                (event) => publish(taskId, event),
                context,
                cacheKey,
                abort
            );
            const completion = Promise.resolve()
                .then(() => execution.run())
                .then(
                    (result) => {
                        task.view.status = 'completed';
                        task.terminal = { type: 'task_completed', taskId, result };
                        publish(taskId, task.terminal);
                        return result;
                    },
                    (error: unknown) => {
                        const failure =
                            error instanceof AgentError
                                ? error
                                : new AgentError('UNKNOWN', false, { cause: error });
                        task.view.status =
                            failure.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed';
                        task.view.errorCode = failure.code;
                        task.terminal = {
                            type:
                                task.view.status === 'cancelled' ? 'task_cancelled' : 'task_failed',
                            taskId,
                            errorCode: failure.code,
                        };
                        publish(taskId, task.terminal);
                        throw failure;
                    }
                )
                .finally(() => {
                    task.detach();
                    for (const conversationKey of task.conversationKeys) {
                        if (conversations.get(conversationKey) === taskId)
                            conversations.delete(conversationKey);
                    }
                    task.conversationKeys.clear();
                    if (!disposed)
                        task.retention = setTimeout(() => release(taskId), TERMINAL_RETENTION_MS);
                });
            const task: Task = {
                view: {
                    taskId,
                    conversationKey: request.conversationKey ?? null,
                    turnKey: null,
                    modelKey: request.modelKey ?? null,
                    status: 'running',
                    attempt: 0,
                    errorCode: null,
                },
                controller,
                decisions,
                conversationKeys: new Set(request.conversationKey ? [request.conversationKey] : []),
                listeners: new Set(),
                completion,
                detach: () => request.signal?.removeEventListener('abort', abort),
            };
            tasks.set(taskId, task);
            if (request.conversationKey) conversations.set(request.conversationKey, taskId);
            void completion.then(
                () => undefined,
                () => undefined
            );
            return Object.freeze({ taskId, completion: task.completion });
        },
        getTask(taskId: string): AgentView | null {
            const task = tasks.get(taskId);
            return task ? snapshotValue({ ...task.view }) : null;
        },
        subscribe(taskId: string, listener: (event: AgentEvent) => void): () => void {
            const task = tasks.get(taskId);
            if (!task) throw new AgentError('TASK_NOT_FOUND');
            task.listeners.add(listener);
            for (const pending of task.decisions.pending) listener(pending);
            if (task.terminal) listener(snapshotValue(task.terminal));
            return () => {
                task.listeners.delete(listener);
            };
        },
        reply(reply: { taskId: string; decisionId: string; value: unknown }): boolean {
            return tasks.get(reply.taskId)?.decisions.reply(reply.decisionId, reply.value) ?? false;
        },
        cancel(taskId: string): boolean {
            const task = tasks.get(taskId);
            if (!task || ['completed', 'failed', 'cancelled'].includes(task.view.status))
                return false;
            task.controller.abort();
            return true;
        },
        async dispose(): Promise<void> {
            if (disposed) return;
            disposed = true;
            for (const task of tasks.values()) {
                task.controller.abort();
                if (task.retention !== undefined) clearTimeout(task.retention);
            }
            await Promise.allSettled([...tasks.values()].map((task) => task.completion));
            for (const taskId of tasks.keys()) release(taskId);
            conversations.clear();
        },
    });
}

export type Agent = ReturnType<typeof createAgent>;
