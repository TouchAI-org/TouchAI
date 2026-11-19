import type { AiMessage, AiToolCall, JsonObject } from '@touchai/models/contracts';
import { addAiUsage, DEFAULT_REASONING_LEVEL, emptyAiUsage } from '@touchai/models/contracts';

import { snapshotMessages, snapshotParts } from '../checkpoints/snapshot';
import { ContextWindow, MAX_SUMMARY_CHARS } from '../context/window';
import type {
    AgentCall,
    AgentCheckpoint,
    AgentEvent,
    AgentPreparedTurn,
    AgentScope,
    OutputPart,
} from '../contracts/agent';
import { AgentError } from '../contracts/agent';
import type { AgentPersistence } from '../contracts/host';
import { LatestProgressWriter } from './progress';
import { throwIfCancelled } from './retry';
import { consumeStream, transportRequest } from './stream';

export interface ExecutionCursor extends AgentCheckpoint {
    currentParts: OutputPart[];
    privateContents: Map<number, AiMessage['content']>;
    calls: AgentCall[];
    toolArgumentErrors: number;
    hasVisibleOutput: boolean;
    hasToolActivity: boolean;
}

export interface ModelStep {
    parts: OutputPart[];
    calls: AiToolCall[];
    call: AgentCall;
}

function mergeOptions(
    target: Record<string, JsonObject> | undefined,
    incoming: Record<string, JsonObject> | undefined
) {
    if (!incoming) return target;
    const merged = { ...target };
    for (const [provider, values] of Object.entries(incoming))
        merged[provider] = { ...merged[provider], ...values };
    return merged;
}

function flowWindow(arrivals: { at: number; chars: number }[]): number | undefined {
    if (arrivals.length < 2) return undefined;
    const total = arrivals.reduce((sum, item) => sum + item.chars, 0);
    let count = 0;
    let start: number | undefined;
    for (const item of arrivals) {
        count += item.chars;
        if (start === undefined && count >= total * 0.1) start = item.at;
        if (count >= total * 0.9)
            return start !== undefined && item.at > start ? item.at - start : undefined;
    }
    return undefined;
}

export async function consumeStep(
    cursor: ExecutionCursor,
    binding: AgentPreparedTurn,
    scope: AgentScope,
    persistence: AgentPersistence,
    context: ContextWindow,
    cacheKey: string,
    emit: (event: AgentEvent) => void,
    contextCommitted: () => void
): Promise<ModelStep> {
    cursor.currentParts = [];
    cursor.messages = snapshotMessages(cursor.messages);
    for (const message of cursor.messages)
        if (message.summary) await persistence.validateSummary(message, scope);
    const privateContents = new WeakMap(
        cursor.messages.flatMap((message, index) => {
            const content = cursor.privateContents.get(index);
            return content === undefined ? [] : [[message, content] as const];
        })
    );
    const project = (message: (typeof cursor.messages)[number]) => {
        const content = privateContents.get(message);
        return content === undefined ? message : { ...message, content };
    };
    const request = {
        model: binding.model.model,
        connectionKey: binding.model.connectionKey,
        messages: cursor.messages,
        tools: binding.model.supportsTools ? [...binding.tools.declarations] : undefined,
        supportsReasoning: binding.model.supportsReasoning,
        reasoningLevel: DEFAULT_REASONING_LEVEL,
        reasoningOptions: binding.model.reasoningOptions,
        signal: scope.signal,
        promptCacheKey: `${cacheKey}:${binding.model.connectionKey}`,
    };
    const summarize = async (input: typeof request) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (scope.signal.aborted) abort();
        else scope.signal.addEventListener('abort', abort, { once: true });
        const startedAt = Date.now();
        let content = '';
        let hasToolCalls = false;
        let usage = emptyAiUsage();
        let usageReported = false;
        let finishReason: string | undefined;
        try {
            for await (const chunk of consumeStream(
                binding.stream(
                    transportRequest({
                        ...input,
                        signal: controller.signal,
                        messages: input.messages.map(project),
                        toolChoice: binding.model.preserveReasoningCache ? 'auto' : 'none',
                    }),
                    scope
                ),
                controller.signal
            )) {
                throwIfCancelled(scope.signal);
                content += chunk.content;
                hasToolCalls ||= Boolean(chunk.toolCalls?.length || chunk.toolCallDeltas?.length);
                if (content.length > MAX_SUMMARY_CHARS)
                    throw new AgentError('CONTEXT_COMPACTION_FAILED');
                if (chunk.done) {
                    usage = chunk.usage ?? emptyAiUsage();
                    usageReported = chunk.usageReported === true;
                    finishReason = chunk.finishReason;
                    break;
                }
            }
            return { text: content, hasToolCalls, finishReason };
        } finally {
            controller.abort();
            scope.signal.removeEventListener('abort', abort);
            cursor.calls.push({
                iteration: cursor.iteration,
                modelKey: binding.model.key,
                model: binding.model.model,
                connectionKey: binding.model.connectionKey,
                usage,
                usageReported,
                timing: { durationMs: Date.now() - startedAt },
                finishReason,
                toolCallsInStep: 0,
                toolArgumentErrors: 0,
            });
        }
    };
    const prepared = await context.prepare({
        request,
        projectForTransport: project,
        contextLimit: binding.model.contextLimit,
        outputLimit: binding.model.outputLimit,
        preserveSummaryOutputBudget: binding.model.preserveReasoningCache,
        saveSummary: (summary, source) =>
            persistence.saveSummary(summary, source, cursor.calls, scope),
        onCompaction: (event) =>
            emit({ type: 'context_compaction', taskId: scope.taskId, ...event }),
        summarize: (input) => summarize(input as typeof request),
    });
    if (prepared.messages.some((message) => message.summary)) {
        cursor.privateContents.clear();
        for (const [index, message] of prepared.messages.entries()) {
            const content = privateContents.get(message);
            if (content !== undefined) cursor.privateContents.set(index, content);
        }
        cursor.messages = snapshotMessages(prepared.messages);
        contextCommitted();
    }
    const modelRequest = {
        ...request,
        messages: prepared.messages.map(project),
        maxOutputTokens: prepared.maxOutputTokens,
    };
    const writer = new LatestProgressWriter(
        scope,
        (parts, target) => persistence.progress(parts, target),
        () => emit({ type: 'persistence_issue', taskId: scope.taskId, phase: 'progress' })
    );
    let textPart: OutputPart | undefined;
    let reasoningPart: OutputPart | undefined;
    const endText = () => {
        if (textPart) {
            textPart = undefined;
            writer.enqueue(cursor.currentParts);
        }
    };
    const endReasoning = () => {
        if (reasoningPart) {
            reasoningPart.endedAt = Date.now();
            reasoningPart = undefined;
            writer.enqueue(cursor.currentParts);
        }
    };
    const startReasoning = (providerOptions?: Record<string, JsonObject>) => {
        endText();
        if (!reasoningPart) {
            reasoningPart = {
                type: 'reasoning',
                content: '',
                startedAt: Date.now(),
                providerOptions,
            };
            cursor.currentParts.push(reasoningPart);
            cursor.outputParts.push(reasoningPart);
            writer.enqueue(cursor.currentParts);
        }
    };
    let toolCalls: AiToolCall[] = [];
    let usage = emptyAiUsage();
    let usageReported = false;
    let finishReason: string | undefined;
    const startedAt = Date.now();
    let firstContentAt: number | undefined;
    let firstTextAt: number | undefined;
    const arrivals: { at: number; chars: number }[] = [];
    const mark = (length: number, text: boolean) => {
        const at = Date.now();
        firstContentAt ??= at;
        if (text) firstTextAt ??= at;
        if (length) arrivals.push({ at, chars: length });
    };
    let error: unknown;
    let failed = false;
    try {
        for await (const chunk of consumeStream(
            binding.stream(transportRequest(modelRequest), scope),
            scope.signal
        )) {
            throwIfCancelled(scope.signal);
            if (chunk.textState === 'start') {
                endReasoning();
                endText();
            }
            if (chunk.reasoningState === 'start') {
                endReasoning();
                startReasoning(chunk.reasoningProviderOptions);
            }
            if (chunk.reasoning) {
                startReasoning(chunk.reasoningProviderOptions);
                reasoningPart!.content += chunk.reasoning;
                cursor.reasoning += chunk.reasoning;
                cursor.hasVisibleOutput = true;
                mark(chunk.reasoning.length, false);
            }
            // Closing boundaries can carry the signature or encrypted content needed for replay.
            if (reasoningPart && chunk.reasoningProviderOptions) {
                reasoningPart.providerOptions = mergeOptions(
                    reasoningPart.providerOptions,
                    chunk.reasoningProviderOptions
                );
            }
            if (chunk.content) {
                endReasoning();
                if (!textPart) {
                    textPart = { type: 'text', content: '' };
                    cursor.currentParts.push(textPart);
                    cursor.outputParts.push(textPart);
                }
                textPart.content += chunk.content;
                cursor.response += chunk.content;
                cursor.hasVisibleOutput = true;
                mark(chunk.content.length, true);
            }
            if (chunk.toolCallDeltas?.length || chunk.toolCalls?.length) {
                cursor.hasToolActivity = true;
                endReasoning();
                endText();
                mark(0, false);
            }
            if (chunk.reasoningState === 'end' || chunk.done) endReasoning();
            if (chunk.textState === 'end' || chunk.done) endText();
            if (chunk.done) {
                finishReason = chunk.finishReason;
                toolCalls = chunk.toolCalls ?? [];
                usage = chunk.usage ?? emptyAiUsage();
                usageReported = chunk.usageReported === true;
            }
            emit({
                type: 'stream',
                taskId: scope.taskId,
                attemptToken: scope.attemptToken,
                iteration: cursor.iteration,
                chunk,
            });
            if (chunk.done) break;
        }
    } catch (cause) {
        failed = true;
        error = cause;
        finishReason = scope.signal.aborted ? 'aborted' : 'error';
    } finally {
        endReasoning();
        endText();
        writer.close();
        await writer.drain();
    }
    const call: AgentCall = {
        iteration: cursor.iteration,
        modelKey: binding.model.key,
        model: binding.model.model,
        connectionKey: binding.model.connectionKey,
        usage,
        usageReported,
        timing: {
            durationMs: Date.now() - startedAt,
            ttftMs: firstContentAt === undefined ? undefined : firstContentAt - startedAt,
            firstTextMs: firstTextAt === undefined ? undefined : firstTextAt - startedAt,
            flowMs: flowWindow(arrivals),
        },
        finishReason,
        toolCallsInStep: ['tool_calls', 'tool_use'].includes(finishReason ?? '')
            ? toolCalls.length
            : 0,
        toolArgumentErrors: 0,
    };
    cursor.calls.push(call);
    if (usageReported) context.observe(modelRequest, usage);
    if (failed) throw error;
    return {
        call,
        parts: snapshotParts(cursor.currentParts),
        calls: call.toolCallsInStep ? toolCalls : [],
    };
}

export function callsUsage(calls: readonly AgentCall[]) {
    return calls.reduce((sum, call) => addAiUsage(sum, call.usage), emptyAiUsage());
}
