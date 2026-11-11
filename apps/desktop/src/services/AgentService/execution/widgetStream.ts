import { parsePartialJson } from 'ai';

import { showWidgetRawArgsSchema } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/constants';
import {
    SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS,
    SHOW_WIDGET_DRAFT_THROTTLE_MIN_CHARS,
} from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtimeConstants';

import type { AiStreamChunk } from '../contracts/protocol';
import { SKILL_ACKNOWLEDGEMENT_FIELD } from '../skills/widgetAcknowledgement';

const WIDGET_TOOL = 'builtin__show_widget';
const MAX_TRACKED_DRAFTS = 32;

/**
 * One model stream owns this bounded pacing state. Large drafts are sampled before parsing;
 * final arguments bypass pacing. No timer can publish after cancellation or into a retry.
 */
export function createPublicWidgetStream() {
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
            if (
                state !== 'successful-parse' &&
                fields[fields.length - 1] === SKILL_ACKNOWLEDGEMENT_FIELD
            )
                continue;
            if (!showWidgetRawArgsSchema.safeParse(args).success) continue;
            deltas.push({
                ...delta,
                argumentsDelta: undefined,
                argumentsBuffer: JSON.stringify(args),
            });
        }
        const calls = (chunk.toolCalls ?? []).filter((call) => {
            if (call.name !== WIDGET_TOOL) return true;
            try {
                return showWidgetRawArgsSchema.safeParse(JSON.parse(call.arguments)).success;
            } catch {
                return false;
            }
        });
        for (const call of chunk.toolCalls ?? []) sampled.delete(call.id);
        if (chunk.done) sampled.clear();
        return {
            ...chunk,
            ...(chunk.toolCallDeltas ? { toolCallDeltas: deltas } : {}),
            ...(chunk.toolCalls ? { toolCalls: calls } : {}),
        };
    };
}
