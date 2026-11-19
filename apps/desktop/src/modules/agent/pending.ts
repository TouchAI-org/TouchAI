import { AgentError } from '@touchai/agent-core/contracts';

import type { AgentPendingDelivery, PendingMessageStore } from './contracts/host';
import type {
    PendingUserMessage,
    PendingUserMessageDelivery,
    PendingUserMessageInput,
    StartedSessionTask,
    StartSessionTaskOptions,
    TaskViewSnapshot,
} from './contracts/task';
import { cloneTaskValue } from './contracts/task';
import { isTerminalStatus } from './projection/helpers';

export interface PendingQueue {
    sessionId: number | null;
    messages: PendingUserMessage[];
    claimed: Set<string>;
    active?: string;
    latest?: string;
    starting?: { controller: AbortController; message?: PendingUserMessage; preceding: string[] };
    resumeRequested?: boolean;
}

/** One session queue survives projection retention and asynchronous turn handover. */
export function createPendingQueues(input: {
    store?: PendingMessageStore;
    snapshot(taskId: string): TaskViewSnapshot | undefined;
    changed(taskId: string): void;
    delivered(taskId: string, messages: Parameters<AgentPendingDelivery['delivered']>[0]): void;
    rejected(taskId: string, messageIds: string[]): void;
    start(options: StartSessionTaskOptions, queue: PendingQueue): Promise<StartedSessionTask>;
    report(error: unknown): void;
}) {
    const sessions = new Map<number, PendingQueue>();
    const tasks = new Map<string, PendingQueue>();
    let disposed = false;
    const prune = (queue: PendingQueue) => {
        if (
            !queue.latest &&
            !queue.active &&
            !queue.starting &&
            !queue.messages.length &&
            queue.sessionId !== null &&
            sessions.get(queue.sessionId) === queue
        )
            sessions.delete(queue.sessionId);
    };
    const publish = (queue: PendingQueue) => {
        prune(queue);
        const snapshot = queue.latest && input.snapshot(queue.latest);
        if (!snapshot) return;
        snapshot.pendingUserMessages = cloneTaskValue(queue.messages);
        snapshot.updatedAt = Date.now();
        input.changed(snapshot.taskId);
    };
    const persist = (
        queue: PendingQueue,
        write: (store: PendingMessageStore, sessionId: number) => void
    ) => {
        if (queue.sessionId !== null && input.store) write(input.store, queue.sessionId);
    };
    const schedule = (queue: PendingQueue) => {
        queue.resumeRequested = true;
        queueMicrotask(() => {
            void resume(queue).catch(input.report);
        });
    };
    const state = (
        sessionId: number | null,
        messages: PendingUserMessage[] = []
    ): PendingQueue => ({
        sessionId,
        messages: cloneTaskValue(messages),
        claimed: new Set(),
    });
    const restoreStart = (queue: PendingQueue) => {
        const start = queue.starting;
        if (!start) return;
        queue.starting = undefined;
        if (!start.message || start.controller.signal.aborted) {
            prune(queue);
            return;
        }
        const snapshot = queue.latest && input.snapshot(queue.latest);
        if (snapshot)
            snapshot.sessionHistory = snapshot.sessionHistory.filter(
                (message) => message.id !== start.message!.id
            );
        const preceding = new Set(start.preceding);
        const index = queue.messages.findIndex((message) => !preceding.has(message.id));
        queue.messages.splice(index < 0 ? queue.messages.length : index, 0, start.message);
        publish(queue);
    };
    async function resume(queue: PendingQueue) {
        if (disposed || queue.active || queue.starting || queue.sessionId === null) return;
        queue.resumeRequested = false;
        const next =
            queue.messages.find((message) => message.delivery === 'priority' && !message.editing) ??
            queue.messages.find((message) => !message.editing);
        if (!next) return;
        const previous = queue.latest && input.snapshot(queue.latest);
        const controller = new AbortController();
        queue.starting = {
            controller,
            message: next,
            preceding: queue.messages
                .slice(0, queue.messages.indexOf(next))
                .map((message) => message.id),
        };
        queue.messages = queue.messages.filter((message) => message.id !== next.id);
        publish(queue);
        try {
            if (!input.store) throw new AgentError('PERSISTENCE_FAILED');
            await input.store.flush(queue.sessionId);
            controller.signal.throwIfAborted();
            const started = await input.start(
                {
                    prompt: next.prompt,
                    sessionId: queue.sessionId,
                    userMessageId: next.id,
                    pendingMessageId: next.id,
                    attachments: next.attachments,
                    inputSnapshot: next.inputSnapshot,
                    modelId:
                        next.modelId ?? (previous ? previous.currentModel?.modelId : undefined),
                    providerId:
                        next.providerId ??
                        (previous ? previous.currentModel?.providerId : undefined),
                    executionMode: previous ? previous.executionMode : 'foreground',
                    signal: controller.signal,
                },
                queue
            );
            void started.completion.catch(input.report);
        } catch (error) {
            restoreStart(queue);
            input.report(error);
        }
    }
    const editable = (queue: PendingQueue | undefined, id: string) =>
        queue && !queue.claimed.has(id)
            ? queue.messages.find((message) => message.id === id && message.delivery === 'queue')
            : undefined;
    const enqueue = (
        queue: PendingQueue | undefined,
        value: PendingUserMessageInput,
        delivery: PendingUserMessageDelivery
    ) => {
        if (!queue || disposed || queue.messages.length >= 20) return null;
        const message: PendingUserMessage = {
            ...cloneTaskValue(value),
            id: crypto.randomUUID(),
            attachments: cloneTaskValue(value.attachments ?? []),
            delivery,
            createdAt: Date.now(),
        };
        queue.messages = [...queue.messages, message];
        persist(queue, (store, id) => store.enqueue(id, message));
        publish(queue);
        if (!queue.active) schedule(queue);
        return cloneTaskValue(message);
    };
    const update = (
        queue: PendingQueue | undefined,
        id: string,
        value: PendingUserMessageInput
    ) => {
        const message = editable(queue, id);
        if (!queue || !message) return false;
        const next = {
            ...message,
            ...cloneTaskValue(value),
            attachments: cloneTaskValue(value.attachments ?? []),
            inputSnapshot: value.inputSnapshot ? cloneTaskValue(value.inputSnapshot) : undefined,
            modelId: value.modelId,
            providerId: value.providerId,
        };
        queue.messages = queue.messages.map((entry) => (entry.id === id ? next : entry));
        persist(queue, (store, sessionId) => store.update(sessionId, next));
        publish(queue);
        return true;
    };
    const editing = (queue: PendingQueue | undefined, id: string, value: boolean) => {
        const message = editable(queue, id);
        if (!queue || !message) return false;
        queue.messages = queue.messages.map((entry) =>
            entry.id === id ? { ...entry, editing: value || undefined } : entry
        );
        publish(queue);
        if (!value && !queue.active) schedule(queue);
        return true;
    };
    const remove = (queue: PendingQueue | undefined, id: string) => {
        if (!queue || queue.claimed.has(id) || !queue.messages.some((message) => message.id === id))
            return false;
        queue.messages = queue.messages.filter((message) => message.id !== id);
        persist(queue, (store, sessionId) => store.remove(sessionId, id));
        publish(queue);
        return true;
    };
    const promote = (queue: PendingQueue | undefined, id: string) => {
        const message = editable(queue, id);
        if (!queue || !message || message.editing) return false;
        queue.messages = queue.messages.map((entry) =>
            entry.id === id ? { ...entry, delivery: 'priority', immediate: true } : entry
        );
        publish(queue);
        if (!queue.active) schedule(queue);
        return true;
    };
    const reorder = (queue: PendingQueue | undefined, ids: readonly string[]) => {
        if (!queue) return false;
        const queued = queue.messages.filter((message) => message.delivery === 'queue');
        const byId = new Map(queued.map((message) => [message.id, message]));
        if (
            ids.length !== queued.length ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !byId.has(id))
        )
            return false;
        let index = 0;
        queue.messages = queue.messages.map((message) =>
            message.delivery === 'queue' ? byId.get(ids[index++]!)! : message
        );
        persist(queue, (store, sessionId) =>
            store.reorder(
                sessionId,
                queue.messages.map((message) => message.id)
            )
        );
        publish(queue);
        return true;
    };
    const clear = (queue: PendingQueue | undefined) => {
        if (!queue || (!queue.messages.length && !queue.starting)) return false;
        queue.starting?.controller.abort();
        queue.starting = undefined;
        queue.messages = [];
        queue.resumeRequested = false;
        queue.claimed.clear();
        persist(queue, (store, sessionId) => store.clear(sessionId));
        publish(queue);
        return true;
    };
    const liveTask = (id: string) => {
        const snapshot = input.snapshot(id);
        return snapshot && !isTerminalStatus(snapshot.status) ? tasks.get(id) : undefined;
    };
    const taskUpdate = (id: string, messageId: string, value: PendingUserMessageInput) => {
        const queue = tasks.get(id);
        if (!queue) return false;
        const snapshot = input.snapshot(id);
        if (
            snapshot &&
            isTerminalStatus(snapshot.status) &&
            !queue.active &&
            !editable(queue, messageId)?.editing
        )
            return false;
        return update(queue, messageId, value);
    };
    return {
        begin(options: StartSessionTaskOptions, inherited?: PendingQueue): PendingQueue {
            if (inherited) return inherited;
            const existing =
                options.sessionId === undefined ? undefined : sessions.get(options.sessionId);
            if (existing?.active || existing?.starting)
                throw new AgentError('SESSION_ACTIVE_TASK_EXISTS');
            const queue = existing ?? state(options.sessionId ?? null, options.pendingUserMessages);
            queue.starting = { controller: new AbortController(), preceding: [] };
            if (queue.sessionId !== null) sessions.set(queue.sessionId, queue);
            return queue;
        },
        rollback: restoreStart,
        restoreUncommitted(taskId: string) {
            const queue = tasks.get(taskId);
            if (queue) restoreStart(queue);
        },
        attach(taskId: string, queue: PendingQueue) {
            const previous = queue.latest && input.snapshot(queue.latest);
            if (previous) {
                previous.pendingUserMessages = [];
                input.changed(previous.taskId);
            }
            queue.latest = taskId;
            queue.active = taskId;
            tasks.set(taskId, queue);
            publish(queue);
        },
        bind(taskId: string, sessionId: number | null) {
            const queue = tasks.get(taskId);
            if (!queue) return;
            if (queue.sessionId === null && sessionId !== null) {
                queue.sessionId = sessionId;
                sessions.set(sessionId, queue);
                for (const message of queue.messages)
                    persist(queue, (store, id) => store.enqueue(id, message));
            }
            queue.starting = undefined;
        },
        async settled(taskId: string) {
            const queue = tasks.get(taskId);
            if (!queue || queue.active !== taskId) return;
            const snapshot = input.snapshot(taskId);
            restoreStart(queue);
            queue.active = undefined;
            queue.claimed.clear();
            queue.messages = [
                ...queue.messages
                    .filter((message) => message.delivery === 'priority')
                    .map((message) => ({
                        ...message,
                        delivery: 'queue' as const,
                        immediate: undefined,
                    })),
                ...queue.messages.filter((message) => message.delivery === 'queue'),
            ];
            persist(queue, (store, id) =>
                store.reorder(
                    id,
                    queue.messages.map((message) => message.id)
                )
            );
            if (queue.sessionId !== null) {
                try {
                    await input.store?.flush(queue.sessionId);
                } catch (error) {
                    input.report(error);
                }
            }
            publish(queue);
            if (snapshot && (snapshot.status !== 'failed' || queue.resumeRequested))
                schedule(queue);
        },
        delivery(queue: PendingQueue): AgentPendingDelivery {
            return {
                claimPriority() {
                    if (!queue.active || disposed) return [];
                    const messages = queue.messages.filter(
                        (message) =>
                            message.delivery === 'priority' &&
                            !message.editing &&
                            !queue.claimed.has(message.id)
                    );
                    for (const message of messages) queue.claimed.add(message.id);
                    return cloneTaskValue(messages);
                },
                releasePriority(ids) {
                    for (const id of ids) queue.claimed.delete(id);
                },
                isClaimCurrent: (id) =>
                    !disposed &&
                    !!queue.active &&
                    queue.claimed.has(id) &&
                    queue.messages.some((message) => message.id === id),
                hasImmediate: () =>
                    !!queue.active &&
                    !disposed &&
                    queue.messages.some(
                        (message) =>
                            message.delivery === 'priority' &&
                            message.immediate &&
                            !message.editing &&
                            !queue.claimed.has(message.id)
                    ),
                async flush() {
                    if (queue.sessionId === null || !input.store)
                        throw new AgentError('PERSISTENCE_FAILED');
                    await input.store.flush(queue.sessionId);
                },
                delivered(messages) {
                    const ids = new Set(messages.map((message) => message.id));
                    queue.messages = queue.messages.filter((message) => !ids.has(message.id));
                    for (const id of ids) queue.claimed.delete(id);
                    if (queue.active) input.delivered(queue.active, messages);
                    publish(queue);
                },
                rejected(ids) {
                    queue.messages = queue.messages.filter((message) => !ids.includes(message.id));
                    for (const id of ids) queue.claimed.delete(id);
                    if (queue.active) input.rejected(queue.active, ids);
                    publish(queue);
                },
            };
        },
        commands: {
            enqueueTaskUserMessage: (
                id: string,
                value: PendingUserMessageInput,
                delivery: PendingUserMessageDelivery
            ) => enqueue(liveTask(id), value, delivery),
            enqueueSessionUserMessage: (
                id: number,
                value: PendingUserMessageInput,
                delivery: PendingUserMessageDelivery
            ) => {
                const queue = sessions.get(id);
                return enqueue(
                    queue && (queue.active || queue.starting || queue.messages.length)
                        ? queue
                        : undefined,
                    value,
                    delivery
                );
            },
            updateTaskUserMessage: taskUpdate,
            updateSessionUserMessage: (
                id: number,
                messageId: string,
                value: PendingUserMessageInput
            ) => update(sessions.get(id), messageId, value),
            setTaskUserMessageEditing: (id: string, messageId: string, value: boolean) =>
                editing(tasks.get(id), messageId, value),
            setSessionUserMessageEditing: (id: number, messageId: string, value: boolean) =>
                editing(sessions.get(id), messageId, value),
            clearUserMessageEditing(messageId: string) {
                for (const queue of new Set([...tasks.values(), ...sessions.values()]))
                    if (
                        queue.messages.some(
                            (message) => message.id === messageId && message.editing
                        )
                    )
                        return editing(queue, messageId, false);
                return false;
            },
            removeTaskUserMessage: (id: string, messageId: string) =>
                remove(liveTask(id), messageId),
            removeSessionUserMessage: (id: number, messageId: string) =>
                remove(sessions.get(id), messageId),
            promoteTaskUserMessage: (id: string, messageId: string) =>
                promote(liveTask(id), messageId),
            promoteSessionUserMessage: (id: number, messageId: string) =>
                promote(sessions.get(id), messageId),
            reorderTaskQueuedMessages: (id: string, ids: readonly string[]) =>
                reorder(liveTask(id), ids),
            reorderSessionQueuedMessages: (id: number, ids: readonly string[]) =>
                reorder(sessions.get(id), ids),
            clearTaskUserMessages: (id: string) => clear(tasks.get(id)),
            clearSessionUserMessages: (id: number) => clear(sessions.get(id)),
            updateTaskUserMessageModel(
                id: string,
                modelId: string | null,
                providerId: number | null
            ) {
                const queue = tasks.get(id);
                if (!queue?.messages.length) return false;
                queue.messages = queue.messages.map((message) =>
                    queue.claimed.has(message.id)
                        ? message
                        : {
                              ...message,
                              modelId: modelId ?? undefined,
                              providerId: providerId ?? undefined,
                          }
                );
                persist(queue, (store, sessionId) =>
                    store.updateModel(sessionId, modelId, providerId)
                );
                publish(queue);
                return true;
            },
            async restoreSessionQueue(id: number) {
                if (disposed) return [];
                const existing = sessions.get(id);
                if (existing) return cloneTaskValue(existing.messages);
                try {
                    const restored = (await input.store?.load(id)) ?? [];
                    if (disposed) return [];
                    const queue = sessions.get(id) ?? state(id, restored);
                    if (restored.length) sessions.set(id, queue);
                    return cloneTaskValue(queue.messages);
                } catch (error) {
                    input.report(error);
                    return [];
                }
            },
            resumeSessionQueue(id: number) {
                const queue = sessions.get(id);
                if (queue) schedule(queue);
            },
        },
        release(taskId: string) {
            const queue = tasks.get(taskId);
            tasks.delete(taskId);
            if (queue?.latest === taskId) queue.latest = undefined;
            if (queue) prune(queue);
        },
        dispose() {
            disposed = true;
            for (const queue of new Set([...tasks.values(), ...sessions.values()]))
                queue.starting?.controller.abort();
            tasks.clear();
            sessions.clear();
        },
    };
}
