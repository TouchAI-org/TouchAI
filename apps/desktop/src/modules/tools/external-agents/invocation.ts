import type { AgentCard, Message, SendMessageRequest, Task } from '@a2a-js/sdk';
import type { Client } from '@a2a-js/sdk/client';

import {
    EXTERNAL_AGENT_CANCEL_TIMEOUT_MS,
    EXTERNAL_AGENT_FINAL_TEXT_MAX_BYTES,
    EXTERNAL_AGENT_INVOCATION_TIMEOUT_MS,
    EXTERNAL_AGENT_POLLING_DEFAULTS,
} from './constants';
import type {
    ExternalAgentInvocationMode,
    ExternalAgentInvocationResult,
    ExternalAgentPollingOptions,
} from './contracts';
import { resolveCompatibleInterface } from './discovery';
import { ExternalAgentError } from './errors';
import {
    ExternalAgentStreamAccumulator,
    isInterruptedTaskState,
    isTerminalTaskState,
    messageText,
    taskState,
    taskText,
} from './stream';
import { createGuardedFetch, isLoopbackExternalAgentUrl, parseExternalAgentUrl } from './urlPolicy';

export interface ExternalAgentInvocationOptions {
    fetchImpl: typeof fetch;
    mode: ExternalAgentInvocationMode;
    onSnapshot?(text: string): void;
    polling?: Partial<ExternalAgentPollingOptions>;
    signal?: AbortSignal;
    streamSnapshotIntervalMs?: number;
    timeoutMs?: number;
    url: string;
}

function truncateUtf8(text: string, maxBytes = EXTERNAL_AGENT_FINAL_TEXT_MAX_BYTES): string {
    const encoder = new TextEncoder();
    if (encoder.encode(text).byteLength <= maxBytes) return text;
    const marker = '\n[truncated]';
    const textBudget = Math.max(0, maxBytes - encoder.encode(marker).byteLength);
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (encoder.encode(text.slice(0, middle)).byteLength <= textBudget) low = middle;
        else high = middle - 1;
    }
    let end = low;
    if (
        end > 0 &&
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
    ) {
        end -= 1;
    }
    return `${text.slice(0, end)}${marker}`;
}

function invocationErrorCode(error: unknown): ExternalAgentInvocationResult['code'] {
    if (error instanceof ExternalAgentError) return error.code;
    const statusCode =
        typeof error === 'object' && error !== null && 'statusCode' in error
            ? error.statusCode
            : undefined;
    if (statusCode === 401 || statusCode === 403) return 'auth_required';
    if (/maximum allowed size/i.test(error instanceof Error ? error.message : ''))
        return 'payload_too_large';
    if (typeof statusCode === 'number' && statusCode >= 400) return 'request_failed';
    return 'invalid_response';
}

function createSnapshotEmitter(
    emit: ((text: string) => void) | undefined,
    intervalMs: number
): { push(text: string): void; flush(): void; dispose(): void } {
    let lastEmitAt = Number.NEGATIVE_INFINITY;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    const send = (text: string) => {
        pending = null;
        lastEmitAt = Date.now();
        lastSent = text;
        emit?.(text);
    };
    let lastSent = '';
    return {
        push(text) {
            if (!emit || !text || text === lastSent) return;
            const now = Date.now();
            if (timer === null && now - lastEmitAt >= intervalMs) {
                send(text);
                return;
            }
            pending = text;
            if (timer !== null) return;
            timer = setTimeout(
                () => {
                    timer = null;
                    if (pending && pending !== lastSent) {
                        send(pending);
                    }
                },
                Math.max(0, intervalMs - (now - lastEmitAt))
            );
        },
        flush() {
            clear();
            if (pending && pending !== lastSent) {
                send(pending);
            }
        },
        dispose() {
            clear();
            pending = null;
        },
    };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function createClient(card: AgentCard, fetchImpl: typeof fetch): Promise<Client> {
    const sdk = await import('@a2a-js/sdk/client');
    const factory = new sdk.ClientFactory({
        transports: [new sdk.RestTransportFactory({ fetchImpl })],
        preferredTransports: ['HTTP+JSON'],
    });
    return await factory.createFromAgentCard(card);
}

function userMessage(text: string): Message {
    return {
        messageId: crypto.randomUUID(),
        contextId: '',
        taskId: '',
        role: 1 as Message['role'],
        parts: [
            {
                content: { $case: 'text', value: text },
                metadata: undefined,
                filename: '',
                mediaType: 'text/plain',
            },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
    };
}

function request(text: string, returnImmediately: boolean): SendMessageRequest {
    return {
        tenant: '',
        message: userMessage(text),
        configuration: {
            acceptedOutputModes: ['text/plain'],
            taskPushNotificationConfig: undefined,
            historyLength: 0,
            returnImmediately,
        },
        metadata: undefined,
    };
}

function asTask(value: Message | Task): Task | undefined {
    return 'id' in value && typeof value.id === 'string' ? value : undefined;
}

function completedResult(task: Task, taskId = task.id): ExternalAgentInvocationResult {
    const state = taskState(task);
    if (state === 3) {
        return {
            sideEffect: 'completed',
            status: 'success',
            taskId,
            text: truncateUtf8(taskText(task)),
        };
    }
    if (state === 5) {
        return { code: 'cancelled', sideEffect: 'none', status: 'error', taskId, text: '' };
    }
    if (state === 6) {
        return {
            code: 'request_failed',
            sideEffect: 'unknown',
            status: 'error',
            taskId,
            text: '',
        };
    }
    if (state === 8) {
        return {
            code: 'auth_required',
            sideEffect: 'unknown',
            status: 'error',
            taskId,
            text: '',
        };
    }
    return {
        code: 'request_failed',
        sideEffect: 'unknown',
        status: 'error',
        taskId,
        text: '',
    };
}

async function cancelRemoteTask(client: Client, taskId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTERNAL_AGENT_CANCEL_TIMEOUT_MS);
    try {
        await client.cancelTask(
            { tenant: '', id: taskId, metadata: undefined },
            { signal: controller.signal }
        );
    } catch {
        // Cancellation is best effort; the stable tool result still reports the local cancel.
    } finally {
        clearTimeout(timer);
    }
}

async function pollTask(
    client: Client,
    initial: Task,
    signal: AbortSignal,
    options: ExternalAgentPollingOptions
): Promise<ExternalAgentInvocationResult> {
    const deadline = Date.now() + options.timeoutMs;
    let delay = options.initialDelayMs;
    let current = initial;
    while (!isTerminalTaskState(taskState(current))) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            return {
                code: 'polling_timeout',
                sideEffect: 'unknown',
                status: 'timeout',
                taskId: current.id,
                text: '',
            };
        await abortableDelay(Math.min(delay, remaining), signal);
        current = await client.getTask(
            { tenant: '', id: current.id, historyLength: 0 },
            { signal }
        );
        const state = taskState(current);
        if (isInterruptedTaskState(state)) return completedResult(current);
        delay = Math.min(options.maxDelayMs, Math.max(delay + 1, Math.floor(delay * 1.5)));
    }
    return completedResult(current);
}

export async function invokeRegisteredExternalAgent(input: {
    allowLoopback: boolean;
    card: AgentCard;
    fetchImpl: typeof fetch;
    message: string;
    mode: ExternalAgentInvocationMode;
    onSnapshot?(text: string): void;
    polling?: Partial<ExternalAgentPollingOptions>;
    signal?: AbortSignal;
    streamSnapshotIntervalMs?: number;
    timeoutMs?: number;
    url: string;
}): Promise<ExternalAgentInvocationResult> {
    let baseUrl: URL;
    try {
        baseUrl = parseExternalAgentUrl(input.url, input.allowLoopback);
        resolveCompatibleInterface(input.card, baseUrl, input.allowLoopback);
    } catch (error) {
        const code = error instanceof ExternalAgentError ? error.code : 'card_malformed';
        return { code, sideEffect: 'none', status: 'error', text: '' };
    }
    return await invokeParsedCard({
        ...input,
        baseUrl,
        card: input.card,
    });
}

async function invokeParsedCard(input: {
    baseUrl: URL;
    card: AgentCard;
    fetchImpl: typeof fetch;
    message: string;
    mode: ExternalAgentInvocationMode;
    onSnapshot?(text: string): void;
    polling?: Partial<ExternalAgentPollingOptions>;
    signal?: AbortSignal;
    streamSnapshotIntervalMs?: number;
    timeoutMs?: number;
}): Promise<ExternalAgentInvocationResult> {
    if (input.card.securityRequirements.length > 0)
        return { code: 'auth_required', sideEffect: 'none', status: 'error', text: '' };

    const guardedFetch = createGuardedFetch(input.fetchImpl, {
        allowLoopback: isLoopbackExternalAgentUrl(input.baseUrl),
    });
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('timeout', 'TimeoutError'));
    }, input.timeoutMs ?? EXTERNAL_AGENT_INVOCATION_TIMEOUT_MS);
    let client: Client | undefined;
    let taskId: string | undefined;
    let partialText = '';
    const snapshots = createSnapshotEmitter(
        (text) => input.onSnapshot?.(truncateUtf8(text)),
        input.streamSnapshotIntervalMs ?? 100
    );
    try {
        client = await createClient(input.card, guardedFetch);
        const mode =
            input.mode === 'auto'
                ? input.card.capabilities?.streaming
                    ? 'stream'
                    : 'sync'
                : input.mode;
        if (mode === 'stream' && !input.card.capabilities?.streaming)
            return { code: 'interface_unavailable', sideEffect: 'none', status: 'error', text: '' };

        if (mode === 'stream') {
            const accumulator = new ExternalAgentStreamAccumulator();
            for await (const response of client.sendMessageStream(request(input.message, false), {
                signal: controller.signal,
            })) {
                const text = accumulator.apply(response);
                taskId = accumulator.currentTaskId() ?? taskId;
                if (text) {
                    partialText = truncateUtf8(text);
                    snapshots.push(partialText);
                }
                if (accumulator.terminal) break;
            }
            snapshots.flush();
            if (!accumulator.terminal)
                return {
                    code: 'stream_disconnected',
                    sideEffect: 'unknown',
                    status: 'error',
                    taskId,
                    text: partialText,
                };
            if (accumulator.state === 3)
                return {
                    sideEffect: 'completed',
                    status: 'success',
                    taskId,
                    text: partialText,
                };
            if (accumulator.state === 8)
                return {
                    code: 'auth_required',
                    sideEffect: 'unknown',
                    status: 'error',
                    taskId,
                    text: partialText,
                };
            return {
                code: accumulator.state === 5 ? 'cancelled' : 'request_failed',
                sideEffect: 'unknown',
                status: 'error',
                taskId,
                text: partialText,
            };
        }

        const response = await client.sendMessage(request(input.message, mode === 'async'), {
            signal: controller.signal,
        });
        const task = asTask(response);
        if (!task) {
            return {
                sideEffect: 'completed',
                status: 'success',
                text: truncateUtf8(messageText(response)),
            };
        }
        taskId = task.id;
        if (mode === 'async' && !isTerminalTaskState(taskState(task))) {
            return await pollTask(client, task, controller.signal, {
                ...EXTERNAL_AGENT_POLLING_DEFAULTS,
                ...input.polling,
            });
        }
        return completedResult(task);
    } catch (error) {
        if (client && taskId && (input.signal?.aborted || timedOut))
            await cancelRemoteTask(client, taskId);
        if (input.signal?.aborted)
            return {
                code: 'cancelled',
                sideEffect: 'unknown',
                status: 'error',
                taskId,
                text: partialText,
            };
        if (timedOut)
            return {
                code: 'timeout',
                sideEffect: 'unknown',
                status: 'timeout',
                taskId,
                text: partialText,
            };
        return {
            code: invocationErrorCode(error),
            sideEffect: 'unknown',
            status: 'error',
            taskId,
            text: partialText,
        };
    } finally {
        snapshots.dispose();
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', abort);
    }
}
