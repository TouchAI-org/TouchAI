// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { createToolPart } from '@database/queries/toolParts';
import { serializeAuditPayload } from '@services/ObservabilityService/redact';
import { log } from '@services/ObservabilityService';

import type { AiToolCall } from '../../contracts/tooling';

function safeServerId(value: string | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function toolIdentity(name: string): {
    kind: 'builtin' | 'mcp';
    data: Record<string, unknown>;
} {
    if (name.startsWith('builtin__')) {
        return {
            kind: 'builtin',
            data: { tool_id: name.slice('builtin__'.length) },
        };
    }

    const mcp = /^mcp__(\d+)__(.+)$/.exec(name);
    if (mcp) {
        return {
            kind: 'mcp',
            data: {
                server_id: safeServerId(mcp[1]),
                tool_name: mcp[2],
            },
        };
    }

    return {
        kind: 'mcp',
        data: { server_id: null, tool_name: name },
    };
}

/**
 * Persist a call that failed before an adapter could create its normal tool log.
 * `requestedName` keeps non-canonical names intact when history is replayed.
 */
export async function recordRejectedToolCall(options: {
    toolCall: AiToolCall;
    input: unknown;
    result: string;
    iteration: number;
    sessionId: number;
    messageId: number | null;
}): Promise<number> {
    const identity = toolIdentity(options.toolCall.name);
    try {
        const part = await createToolPart(identity.kind, {
            ...identity.data,
            tool_call_id: options.toolCall.id,
            session_id: options.sessionId,
            message_id: options.messageId,
            iteration: options.iteration,
            input: serializeAuditPayload(options.input),
            output: options.result,
            status: 'error',
            error_message: serializeAuditPayload(options.result),
            requestedName: options.toolCall.name,
        });
        if (typeof part.id !== 'number') {
            throw new Error('Persisted tool part has no id');
        }
        return part.id;
    } catch (error) {
        log.error('[ToolDispatch] Failed to persist a rejected tool call:', error, {
            toolCallId: options.toolCall.id,
            sessionId: options.sessionId,
            messageId: options.messageId,
            iteration: options.iteration,
        });
        throw error;
    }
}
