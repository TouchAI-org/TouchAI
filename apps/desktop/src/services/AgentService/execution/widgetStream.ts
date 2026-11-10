import { parsePartialJson } from 'ai';

import type { AiStreamChunk } from '../contracts/protocol';
import type { AiToolCall } from '../contracts/tooling';
import { publicWidgetArguments, type WidgetSkillAccess } from '../skills/widgetAccess';

const WIDGET_TOOL = 'builtin__show_widget';

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

/** Credentials stay in the provider/executor path, before any public projection sees a draft. */
export async function publicWidgetChunk(
    chunk: AiStreamChunk,
    access: WidgetSkillAccess
): Promise<AiStreamChunk> {
    const deltas = [];
    for (const delta of chunk.toolCallDeltas ?? []) {
        if (delta.name !== WIDGET_TOOL) {
            deltas.push(delta);
            continue;
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
    return {
        ...chunk,
        ...(chunk.toolCallDeltas ? { toolCallDeltas: deltas } : {}),
        ...(chunk.toolCalls ? { toolCalls: calls } : {}),
    };
}
