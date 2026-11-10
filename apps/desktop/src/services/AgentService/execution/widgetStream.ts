import { parsePartialJson } from 'ai';

import {
    SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS,
    SHOW_WIDGET_DRAFT_THROTTLE_MIN_CHARS,
} from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtimeConstants';

import type { AiStreamChunk } from '../contracts/protocol';
import type { AiToolCall } from '../contracts/tooling';
import { publicWidgetArguments, type WidgetSkillAccess } from '../skills/widgetAccess';

const WIDGET_TOOL = 'builtin__show_widget';
const MAX_TRACKED_DRAFTS = 32;

export function publicToolCall(call: AiToolCall): AiToolCall {
    if (call.name !== WIDGET_TOOL) return call;
    try {
        return {
            ...call,
            arguments: JSON.stringify(publicWidgetArguments(JSON.parse(call.arguments))),
        };
    } catch {
        return { ...call, arguments: '{}' };
    }
}

/**
 * One model stream owns this bounded pacing state. Large drafts are sampled before parsing;
 * final arguments bypass pacing. No timer can publish after cancellation or into a retry.
 */
export function createPublicWidgetStream(access: WidgetSkillAccess) {
    const sampled = new Map<string | number, { at: number; length: number }>();
    return async (chunk: AiStreamChunk): Promise<AiStreamChunk> => {
        const deltas = [];
        for (const delta of chunk.toolCallDeltas ?? []) {
            if (delta.name !== WIDGET_TOOL) {
                deltas.push(delta);
                continue;
            }
            const id = delta.callId ?? delta.index;
            if (delta.isComplete || chunk.done) {
                sampled.delete(id);
            } else if (delta.argumentsBuffer.length >= SHOW_WIDGET_DRAFT_THROTTLE_MIN_CHARS) {
                const now = performance.now();
                const previous = sampled.get(id);
                if (
                    previous &&
                    delta.argumentsBuffer.length >= previous.length &&
                    now - previous.at < SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS
                )
                    continue;
                sampled.delete(id);
                if (sampled.size >= MAX_TRACKED_DRAFTS) {
                    sampled.delete(sampled.keys().next().value!);
                }
                sampled.set(id, { at: now, length: delta.argumentsBuffer.length });
            }
            const { value, state } = await parsePartialJson(delta.argumentsBuffer);
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const args = value as Record<string, unknown>;
            const fields = Object.keys(args);
            // Partial JSON repair can close a still-growing credential string. Wait for
            // the next argument (normally widget_code), or a complete JSON document.
            if (state !== 'successful-parse' && fields[fields.length - 1] === 'skill_key') continue;
            if (!access.isAuthorized(args.skill_key)) continue;
            deltas.push({
                ...delta,
                argumentsDelta: undefined,
                argumentsBuffer: JSON.stringify(publicWidgetArguments(args)),
            });
        }
        const calls = (chunk.toolCalls ?? [])
            .filter((call) => {
                if (call.name !== WIDGET_TOOL) return true;
                try {
                    return access.isAuthorized(JSON.parse(call.arguments)?.skill_key);
                } catch {
                    return false;
                }
            })
            .map(publicToolCall);
        for (const call of chunk.toolCalls ?? []) sampled.delete(call.id);
        if (chunk.done) sampled.clear();
        return {
            ...chunk,
            ...(chunk.toolCallDeltas ? { toolCallDeltas: deltas } : {}),
            ...(chunk.toolCalls ? { toolCalls: calls } : {}),
        };
    };
}
