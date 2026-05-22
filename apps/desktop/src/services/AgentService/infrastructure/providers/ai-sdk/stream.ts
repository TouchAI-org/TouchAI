// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { FinishReason, TextStreamPart, ToolSet } from 'ai';

import type { AiStreamChunk, JsonObject } from '@/services/AgentService/contracts/protocol';
import type { AiToolCall } from '@/services/AgentService/contracts/tooling';

import { normalizeToolName, toJsonObjectRecord } from './utils';

interface ToolStreamState {
    nextIndex: number;
    indexesByCallId: Map<string, number>;
    buffersByCallId: Map<string, string>;
    namesByCallId: Map<string, string>;
    providerOptionsByCallId: Map<string, Record<string, JsonObject>>;
    finalToolCallsByCallId: Map<string, AiToolCall>;
}

function createInitialState(): ToolStreamState {
    return {
        nextIndex: 0,
        indexesByCallId: new Map(),
        buffersByCallId: new Map(),
        namesByCallId: new Map(),
        providerOptionsByCallId: new Map(),
        finalToolCallsByCallId: new Map(),
    };
}

function getToolIndex(state: ToolStreamState, callId: string): number {
    const existingIndex = state.indexesByCallId.get(callId);
    if (existingIndex !== undefined) {
        return existingIndex;
    }

    const nextIndex = state.nextIndex;
    state.nextIndex += 1;
    state.indexesByCallId.set(callId, nextIndex);
    return nextIndex;
}

function stringifyToolInput(input: unknown): string {
    if (typeof input === 'string') {
        return input;
    }

    try {
        const serialized = JSON.stringify(input);
        return typeof serialized === 'string' ? serialized : '{}';
    } catch {
        return '{}';
    }
}

function isEmptyStructuredToolInput(input: unknown): boolean {
    if (input === undefined || input === null) {
        return true;
    }

    if (typeof input === 'string') {
        return input.trim().length === 0;
    }

    if (Array.isArray(input)) {
        return input.length === 0;
    }

    return typeof input === 'object' && Object.keys(input).length === 0;
}

function parseBufferedToolInput(buffer: string): unknown | undefined {
    if (!buffer.trim()) {
        return undefined;
    }

    try {
        return JSON.parse(buffer) as unknown;
    } catch {
        return undefined;
    }
}

function buildFallbackToolCall(state: ToolStreamState, callId: string): AiToolCall | null {
    const toolName = normalizeToolName(state.namesByCallId.get(callId));
    if (!toolName) {
        return null;
    }

    const bufferedArguments = state.buffersByCallId.get(callId) ?? '';
    const argumentsBuffer = bufferedArguments.trim() ? bufferedArguments : '{}';
    return {
        id: callId,
        name: toolName,
        arguments: argumentsBuffer,
        providerOptions: state.providerOptionsByCallId.get(callId),
    };
}

function buildToolCallsForFinish(
    state: ToolStreamState,
    reason: FinishReason | undefined
): AiToolCall[] {
    const toolCallsByCallId = new Map(state.finalToolCallsByCallId);
    const shouldBackfillMissingToolCalls = reason === 'tool-calls';

    if (shouldBackfillMissingToolCalls) {
        for (const callId of state.namesByCallId.keys()) {
            if (toolCallsByCallId.has(callId)) {
                continue;
            }

            const fallbackToolCall = buildFallbackToolCall(state, callId);
            if (fallbackToolCall) {
                toolCallsByCallId.set(callId, fallbackToolCall);
            }
        }
    }

    return [...toolCallsByCallId.values()].sort((left, right) => {
        return getToolIndex(state, left.id) - getToolIndex(state, right.id);
    });
}

function mapFinishReason(reason: FinishReason | undefined, hasToolCalls: boolean): string {
    if (hasToolCalls) {
        return 'tool_calls';
    }

    if (reason === 'tool-calls') {
        return 'tool_calls';
    }

    return reason ?? 'stop';
}

/**
 * 把 AI SDK 全量流事件收束成应用现有的增量协议。
 */
export function createAiSdkStreamProcessor() {
    const state = createInitialState();

    /**
     * 透传 providerMetadata，保留各家 SDK 已经显式暴露的工具调用元数据。
     */
    function captureProviderOptions(
        callId: string,
        providerMetadata: unknown
    ): Record<string, JsonObject> | undefined {
        const normalized = toJsonObjectRecord(providerMetadata);
        if (!normalized) {
            return undefined;
        }

        state.providerOptionsByCallId.set(callId, normalized);
        return normalized;
    }

    function consumePart<TOOLS extends ToolSet>(part: TextStreamPart<TOOLS>): AiStreamChunk[] {
        if (part.type === 'text-delta') {
            return [{ content: part.text, done: false }];
        }

        if (part.type === 'reasoning-delta') {
            return [{ content: '', reasoning: part.text, done: false }];
        }

        if (part.type === 'tool-input-start') {
            const toolName = normalizeToolName(part.toolName);
            if (!toolName) {
                return [];
            }

            const index = getToolIndex(state, part.id);
            state.namesByCallId.set(part.id, toolName);
            state.buffersByCallId.set(part.id, '');
            captureProviderOptions(
                part.id,
                (part as { providerMetadata?: unknown }).providerMetadata
            );

            return [
                {
                    content: '',
                    done: false,
                    toolCallDeltas: [
                        {
                            index,
                            callId: part.id,
                            name: toolName,
                            argumentsBuffer: '',
                            isComplete: false,
                        },
                    ],
                },
            ];
        }

        if (part.type === 'tool-input-delta') {
            const toolName = normalizeToolName(state.namesByCallId.get(part.id));
            if (!toolName) {
                return [];
            }

            const index = getToolIndex(state, part.id);
            const existingBuffer = state.buffersByCallId.get(part.id) ?? '';
            const nextBuffer = `${existingBuffer}${part.delta}`;
            state.buffersByCallId.set(part.id, nextBuffer);

            return [
                {
                    content: '',
                    done: false,
                    toolCallDeltas: [
                        {
                            index,
                            callId: part.id,
                            name: toolName,
                            argumentsDelta: part.delta,
                            argumentsBuffer: nextBuffer,
                            isComplete: false,
                        },
                    ],
                },
            ];
        }

        if (part.type === 'tool-call') {
            const toolName = normalizeToolName(part.toolName);
            if (!toolName) {
                state.indexesByCallId.delete(part.toolCallId);
                state.namesByCallId.delete(part.toolCallId);
                state.buffersByCallId.delete(part.toolCallId);
                state.providerOptionsByCallId.delete(part.toolCallId);
                state.finalToolCallsByCallId.delete(part.toolCallId);
                return [];
            }

            const index = getToolIndex(state, part.toolCallId);
            const bufferedArguments = state.buffersByCallId.get(part.toolCallId) ?? '';
            const parsedBufferedInput = parseBufferedToolInput(bufferedArguments);
            // 某些 provider 会在最终 tool-call 事件里只给一个空对象，
            // 但前面的增量参数其实已经完整流出来了。这里优先信任可解析的
            // 累积 buffer，避免最后一拍的空快照把真实参数覆盖掉。
            const effectiveInput =
                isEmptyStructuredToolInput(part.input) && parsedBufferedInput !== undefined
                    ? parsedBufferedInput
                    : part.input;
            const argumentsBuffer =
                parsedBufferedInput !== undefined && effectiveInput === parsedBufferedInput
                    ? bufferedArguments
                    : stringifyToolInput(effectiveInput);
            const providerOptions =
                captureProviderOptions(
                    part.toolCallId,
                    (part as { providerMetadata?: unknown }).providerMetadata
                ) ?? state.providerOptionsByCallId.get(part.toolCallId);

            state.namesByCallId.set(part.toolCallId, toolName);
            state.buffersByCallId.set(part.toolCallId, argumentsBuffer);
            state.finalToolCallsByCallId.set(part.toolCallId, {
                id: part.toolCallId,
                name: toolName,
                arguments: argumentsBuffer,
                providerOptions,
            });

            return [
                {
                    content: '',
                    done: false,
                    toolCallDeltas: [
                        {
                            index,
                            callId: part.toolCallId,
                            name: toolName,
                            argumentsBuffer,
                            isComplete: true,
                        },
                    ],
                },
            ];
        }

        if (part.type === 'error') {
            const error = part.error instanceof Error ? part.error : new Error(String(part.error));
            throw error;
        }

        return [];
    }

    function buildFinishChunk(reason: FinishReason | undefined): AiStreamChunk {
        const toolCalls = buildToolCallsForFinish(state, reason);

        return {
            content: '',
            done: true,
            finishReason: mapFinishReason(reason, toolCalls.length > 0),
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
    }

    return {
        consumePart,
        buildFinishChunk,
    };
}
