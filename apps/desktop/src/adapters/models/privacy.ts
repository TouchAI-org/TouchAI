import type { AiStreamChunk } from '@touchai/models/contracts';

import { maskTexts, PrivacyMaskingSession, protectionKind } from '@/modules/privacy';
import {
    DEFAULT_PRIVACY_MODEL_ID,
    hashPrivacyText,
    type PrivacyFilterModelId,
    type PrivacyFilterSettings,
    type PrivacyRestoredSpan,
    type PrivacyReviewAnnotation,
} from '@/modules/privacy/public';

import type { DesktopModelMessage } from './input';
interface TextTarget {
    value: string;
    annotationMessageId?: number;
    write(value: string): void;
}
interface PrivacyMaskingResult<T> {
    messages: T[];
    session: PrivacyMaskingSession;
    annotations: PrivacyReviewAnnotation[];
}
export interface PrivacyStreamChunk extends AiStreamChunk {
    privacyRestoration?: { generation: number; spans: PrivacyRestoredSpan[] };
}
export class PrivacyReplayError extends Error {}

// Signed protocol bytes cannot be reconstructed from locally restored display text.
// This cache is deliberately transient and bounded; an unavailable replay fails closed.
const signedReasoning = new Map<string, string>();
const reasoningStreams = new WeakMap<
    PrivacyMaskingSession,
    { raw: string; signature?: string; overflow: boolean }
>();
const REPLAY_BYTES_LIMIT = 64 * 1024;
let replayBytes = 0;
function rememberSignedReasoning(signature: string, raw: string) {
    // A repeated completion can carry a signature without repeating its signed bytes.
    if (signedReasoning.has(signature)) return;
    const size = (signature.length + raw.length) * 2;
    if (size > REPLAY_BYTES_LIMIT) return;
    signedReasoning.set(signature, raw);
    replayBytes += size;
    while (replayBytes > REPLAY_BYTES_LIMIT || signedReasoning.size > 200) {
        const [key, value] = signedReasoning.entries().next().value!;
        replayBytes -= (key.length + value.length) * 2;
        signedReasoning.delete(key);
    }
}

/** A detector failure must not send locally restored reasoning with its old signature. */
export function prepareUnmaskedPrivacyReplay(source: DesktopModelMessage[]): DesktopModelMessage[] {
    return source.map((message) => ({
        ...message,
        content:
            typeof message.content === 'string'
                ? message.content
                : message.content.map((part) => {
                      if (part.type !== 'reasoning') return part;
                      const signature = part.providerOptions?.anthropic?.signature;
                      if (typeof signature !== 'string') return part;
                      const raw = signedReasoning.get(signature);
                      if (raw === undefined)
                          throw new PrivacyReplayError('Signed reasoning replay is unavailable');
                      return { ...part, text: raw };
                  }),
    }));
}
function cloneDesktopModelMessages(source: DesktopModelMessage[]): DesktopModelMessage[] {
    return source.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
            ? message.content.map((part) =>
                  part.type === 'file' || part.type === 'image'
                      ? { ...part, meta: { ...part.meta } }
                      : part.type === 'tool_use'
                        ? {
                              ...part,
                              input: JSON.parse(JSON.stringify(part.input)) as Record<
                                  string,
                                  unknown
                              >,
                          }
                        : { ...part }
              )
            : message.content,
        tool_calls: message.tool_calls?.map((toolCall) => ({ ...toolCall })),
    }));
}

function collectDesktopModelMessageTextTargets(messages: DesktopModelMessage[]) {
    const targets: TextTarget[] = [];
    const commits: Array<() => void> = [];
    const add = (value: unknown, write: (value: string) => void, annotationMessageId?: number) => {
        if (typeof value === 'string' && value.length > 0) {
            targets.push({ value, write, annotationMessageId });
        }
    };
    const visit = (value: unknown, write: (value: unknown) => void) => {
        if (typeof value === 'string') add(value, write);
        else if (Array.isArray(value))
            value.forEach((item, index) =>
                visit(item, (next) => {
                    value[index] = next;
                })
            );
        else if (value && typeof value === 'object') {
            for (const [key, item] of Object.entries(value))
                visit(item, (next) => {
                    (value as Record<string, unknown>)[key] = next;
                });
        }
    };
    const addJson = (text: string, write: (value: string) => void) => {
        let value: unknown = JSON.parse(text);
        visit(value, (next) => {
            value = next;
        });
        commits.push(() => write(JSON.stringify(value)));
    };

    for (const message of messages) {
        if (typeof message.content === 'string') {
            add(
                message.content,
                (value) => {
                    message.content = value;
                },
                message.role === 'user' ? message.contextSource?.id : undefined
            );
        } else {
            for (const part of message.content) {
                switch (part.type) {
                    case 'text':
                    case 'reasoning': {
                        const signature =
                            part.type === 'reasoning'
                                ? part.providerOptions?.anthropic?.signature
                                : undefined;
                        if (typeof signature === 'string') {
                            const raw = signedReasoning.get(signature);
                            if (raw === undefined)
                                throw new PrivacyReplayError(
                                    'Signed reasoning replay is unavailable'
                                );
                            part.text = raw;
                        }
                        const replay = part.text;
                        add(
                            part.text,
                            (value) => {
                                if (typeof signature === 'string' && value !== replay)
                                    throw new PrivacyReplayError(
                                        'Signed reasoning cannot be safely replayed with privacy protection'
                                    );
                                part.text = value;
                            },
                            message.role === 'user' && part.type === 'text'
                                ? message.contextSource?.id
                                : undefined
                        );
                        break;
                    }
                    case 'file':
                        add(part.name, (value) => {
                            part.name = value;
                        });
                        add(part.meta.name, (value) => {
                            part.meta.name = value;
                        });
                        add(part.meta.originPath, (value) => {
                            part.meta.originPath = value;
                        });
                        if (part.textContent !== undefined) {
                            add(part.textContent, (value) => {
                                part.textContent = value;
                            });
                        }
                        break;
                    case 'image':
                        add(part.name, (value) => {
                            part.name = value;
                        });
                        add(part.meta.name, (value) => {
                            part.meta.name = value;
                        });
                        add(part.meta.originPath, (value) => {
                            part.meta.originPath = value;
                        });
                        break;
                    case 'tool_use': {
                        visit(part.input, (value) => {
                            part.input = value as Record<string, unknown>;
                        });
                        break;
                    }
                    case 'tool_result':
                        add(part.content, (value) => {
                            part.content = value;
                        });
                        break;
                }
            }
        }

        for (const toolCall of message.tool_calls ?? []) {
            addJson(toolCall.arguments, (value) => {
                toolCall.arguments = value;
            });
        }
    }
    return { targets, commits };
}

export async function maskDesktopModelMessages(
    sourceMessages: DesktopModelMessage[],
    settings: PrivacyFilterSettings,
    modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID,
    generation = 0,
    recordGeneration?: number
): Promise<PrivacyMaskingResult<DesktopModelMessage>> {
    const session = new PrivacyMaskingSession(generation, recordGeneration);
    const annotations: PrivacyReviewAnnotation[] = [];
    if (!settings.enabled) return { messages: sourceMessages, session, annotations };
    const messages = cloneDesktopModelMessages(sourceMessages);
    const { targets, commits } = collectDesktopModelMessageTextTargets(messages);
    if (targets.length === 0) return { messages, session, annotations };
    const hashes = await Promise.all(
        targets.map((target) =>
            target.annotationMessageId ? hashPrivacyText(target.value) : undefined
        )
    );
    const masked = await maskTexts(
        targets.map((target) => target.value),
        settings,
        session,
        true,
        modelId,
        (index, span, original) => {
            const messageId = targets[index]?.annotationMessageId;
            const textHash = hashes[index];
            if (!messageId || !textHash) return;
            annotations.push({
                messageId,
                textHash,
                start: span.start,
                end: span.end,
                original,
                placeholder: span.placeholder,
                kind: protectionKind(span.kind),
                ...(span.rule ? { rule: { ...span.rule } } : {}),
            });
            if (annotations.length > 200) annotations.shift();
        }
    );
    targets.forEach((target, index) => target.write(masked[index] ?? target.value));
    commits.forEach((commit) => commit());
    return { messages, session, annotations };
}

export function restorePrivacyChunk(
    chunk: PrivacyStreamChunk,
    session: PrivacyMaskingSession,
    restoredToolBuffers: Map<string, string>
): PrivacyStreamChunk {
    const restored = { ...chunk };
    const spans: PrivacyRestoredSpan[] = [];
    restored.content = session.pushText(chunk.content, 'content', (span) => spans.push(span));
    session.captureRestoredContent(chunk.content, spans);
    if (spans.length) {
        restored.privacyRestoration = { generation: session.reviewGeneration, spans };
    }
    if (chunk.textState === 'end' || chunk.done) {
        restored.content += session.flushText('content');
    }
    if (typeof chunk.reasoning === 'string') {
        const reasoningSpans: PrivacyRestoredSpan[] = [];
        restored.reasoning = session.pushText(chunk.reasoning, 'reasoning', (span) =>
            reasoningSpans.push(span)
        );
        session.captureRestoredContent(chunk.reasoning, reasoningSpans, 'reasoning');
    }
    if (chunk.reasoningState === 'start') reasoningStreams.delete(session);
    const reasoning = reasoningStreams.get(session) ?? { raw: '', overflow: false };
    if (!reasoning.overflow && chunk.reasoning) {
        if ((reasoning.raw.length + chunk.reasoning.length) * 2 <= REPLAY_BYTES_LIMIT)
            reasoning.raw += chunk.reasoning;
        else {
            reasoning.raw = '';
            reasoning.overflow = true;
        }
    }
    const signature = chunk.reasoningProviderOptions?.anthropic?.signature;
    if (typeof signature === 'string') reasoning.signature = signature;
    reasoningStreams.set(session, reasoning);
    if (chunk.reasoningState === 'end' || chunk.done) {
        restored.reasoning = (restored.reasoning ?? '') + session.flushText('reasoning');
        if (reasoning.signature && !reasoning.overflow)
            rememberSignedReasoning(reasoning.signature, reasoning.raw);
        reasoningStreams.delete(session);
    }
    const completeTool = (value: string, streamId: string) => {
        const captured = restoredToolBuffers.has(`captured:${streamId}`);
        const output = session.restoreToolArguments(value, captured ? undefined : streamId);
        restoredToolBuffers.set(`captured:${streamId}`, 'true');
        restoredToolBuffers.delete(streamId);
        session.finishToolArguments(streamId);
        return output;
    };
    if (chunk.toolCallDeltas) {
        restored.toolCallDeltas = chunk.toolCallDeltas.map((delta) => {
            const streamId = `tool:${delta.index}`;
            if (delta.callId) restoredToolBuffers.set(`id:${delta.callId}`, streamId);
            if (delta.isComplete && typeof delta.argumentsBuffer === 'string') {
                return {
                    ...delta,
                    argumentsDelta: '',
                    argumentsBuffer: completeTool(delta.argumentsBuffer, streamId),
                };
            }
            const originalDelta = delta.argumentsDelta ?? '';
            const raw = `${restoredToolBuffers.get(streamId) ?? ''}${originalDelta}`;
            if (raw.length > 1024 * 1024)
                throw new Error('Privacy tool arguments exceed the input limit');
            const visibleDelta = session.pushToolArguments(originalDelta, streamId);
            const visibleArguments = `${restoredToolBuffers.get(`visible:${streamId}`) ?? ''}${visibleDelta}`;
            restoredToolBuffers.set(streamId, raw);
            restoredToolBuffers.set(`visible:${streamId}`, visibleArguments);
            return {
                ...delta,
                argumentsDelta: visibleDelta,
                argumentsBuffer: visibleArguments,
            };
        });
    }
    if (chunk.toolCalls) {
        restored.toolCalls = chunk.toolCalls.map((toolCall) => ({
            ...toolCall,
            arguments: completeTool(
                toolCall.arguments,
                restoredToolBuffers.get(`id:${toolCall.id}`) ?? `tool:${toolCall.id}`
            ),
        }));
    }
    if (chunk.done) {
        for (const [key, value] of restoredToolBuffers) {
            if (key.startsWith('tool:')) completeTool(value, key);
        }
    }
    return restored;
}
