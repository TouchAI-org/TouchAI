// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    findMessagesBySessionId,
    findToolLogRowsBySessionId,
    findUnambiguousToolLogByStoredReference,
    type ToolLogHistoryRow,
} from '@database/queries/messages';

import type { AiContentPart, AiMessage } from '../contracts/protocol';
import type { AiToolCall } from '../contracts/tooling';
import { buildAttachmentParts, hydratePersistedAttachments } from '../infrastructure/attachments';

function toTransportToolName(toolLog: ToolLogHistoryRow): string {
    if (toolLog.source === 'builtin') {
        return `builtin__${toolLog.tool_name}`;
    }

    if (toolLog.server_id !== null) {
        return `mcp__${toolLog.server_id}__${toolLog.tool_name}`;
    }

    return toolLog.tool_name;
}

function buildAssistantTransportContent(row: {
    content: string;
    reasoning: string | null;
}): AiMessage['content'] {
    if (!row.reasoning?.trim()) {
        return row.content;
    }

    return [
        { type: 'reasoning', text: row.reasoning },
        ...(row.content ? [{ type: 'text', text: row.content } as const] : []),
    ];
}

const MISSING_TOOL_RESULT_PLACEHOLDER = 'Missing historical tool result.';

/**
 * 将会话历史重组为下一轮请求可继续复用的模型消息。
 */
export async function loadSessionTransportMessages(options: {
    sessionId?: number;
    supportsAttachments?: boolean;
}): Promise<AiMessage[]> {
    const [rows, toolLogs] = options.sessionId
        ? await Promise.all([
              findMessagesBySessionId(options.sessionId),
              findToolLogRowsBySessionId(options.sessionId),
          ])
        : [[], []];
    const supportsAttachments = options.supportsAttachments ?? true;
    const messages: AiMessage[] = [];
    const toolLogsByMessageId = new Map<number, ToolLogHistoryRow[]>();
    const toolLogByIdentity = new Map<string, ToolLogHistoryRow>();
    const pendingResultToolCalls: AiToolCall[] = [];

    for (const toolLog of toolLogs) {
        if (toolLog.message_id !== null) {
            const messageLogs = toolLogsByMessageId.get(toolLog.message_id) ?? [];
            messageLogs.push(toolLog);
            toolLogsByMessageId.set(toolLog.message_id, messageLogs);
        }

        toolLogByIdentity.set(`${toolLog.source}:${toolLog.log_id}`, toolLog);
    }

    const takePendingResultToolCall = (
        toolCallId?: string | null,
        resolvedToolName?: string | null
    ): AiToolCall | undefined => {
        if (!toolCallId) {
            // Try to match by resolved tool name first
            if (resolvedToolName) {
                const nameMatches = pendingResultToolCalls.filter(
                    (toolCall) => toolCall.name === resolvedToolName
                );
                if (nameMatches.length === 1) {
                    const pendingIndex = pendingResultToolCalls.indexOf(nameMatches[0]!);
                    const [toolCall] = pendingResultToolCalls.splice(pendingIndex, 1);
                    return toolCall;
                }
            }
            // Fall back to FIFO if no unique name match
            return pendingResultToolCalls.shift();
        }

        const pendingIndex = pendingResultToolCalls.findIndex(
            (toolCall) => toolCall.id === toolCallId
        );
        if (pendingIndex < 0) {
            return undefined;
        }

        const [toolCall] = pendingResultToolCalls.splice(pendingIndex, 1);
        return toolCall;
    };

    const flushMissingToolResults = (): void => {
        while (pendingResultToolCalls.length > 0) {
            const toolCall = pendingResultToolCalls.shift()!;
            messages.push({
                role: 'tool',
                content: MISSING_TOOL_RESULT_PLACEHOLDER,
                tool_call_id: toolCall.id,
                name: toolCall.name,
            });
        }
    };

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex]!;

        if (row.role === 'tool_call') {
            flushMissingToolResults();

            if (row.tool_call_id) {
                const pendingToolCalls: AiToolCall[] = [];

                while (rowIndex < rows.length) {
                    const toolCallRow = rows[rowIndex]!;
                    if (
                        toolCallRow.role !== 'tool_call' ||
                        toolCallRow.id !== row.id ||
                        !toolCallRow.tool_call_id
                    ) {
                        break;
                    }

                    pendingToolCalls.push({
                        id: toolCallRow.tool_call_id,
                        name: toolCallRow.tool_name ?? toolCallRow.tool_call_id,
                        arguments: toolCallRow.tool_input ?? '{}',
                    });
                    rowIndex += 1;
                }

                rowIndex -= 1;
                messages.push({
                    role: 'assistant',
                    content: buildAssistantTransportContent(row),
                    tool_calls: pendingToolCalls,
                });
                pendingResultToolCalls.push(...pendingToolCalls);
                continue;
            }

            const pendingToolCalls: AiToolCall[] =
                toolLogsByMessageId.get(row.id)?.map((toolLog) => ({
                    id: toolLog.tool_call_id,
                    name: toTransportToolName(toolLog),
                    arguments: toolLog.tool_input ?? '{}',
                })) ?? [];

            messages.push({
                role: 'assistant',
                content: buildAssistantTransportContent(row),
                tool_calls: pendingToolCalls,
            });
            pendingResultToolCalls.push(...pendingToolCalls);
            continue;
        }

        if (row.role === 'tool_result') {
            const toolLog = findUnambiguousToolLogByStoredReference(
                toolLogByIdentity,
                row.tool_log_id,
                row.tool_log_kind
            );
            const resolvedToolName =
                row.tool_name ?? (toolLog ? toTransportToolName(toolLog) : undefined);
            const pendingToolCall = takePendingResultToolCall(
                row.tool_call_id ?? toolLog?.tool_call_id,
                resolvedToolName
            );

            if (pendingToolCall) {
                const attachments = supportsAttachments
                    ? await hydratePersistedAttachments(row.attachments)
                    : [];
                const attachmentParts =
                    attachments.length > 0
                        ? await buildAttachmentParts(attachments, {
                              includeAnchorText: false,
                          })
                        : [];
                messages.push({
                    role: 'tool',
                    content:
                        attachmentParts.length > 0
                            ? ([
                                  ...(row.content ? [{ type: 'text', text: row.content }] : []),
                                  ...attachmentParts,
                              ] as AiContentPart[])
                            : row.content,
                    tool_call_id: pendingToolCall.id,
                    name:
                        row.tool_name ??
                        (toolLog ? toTransportToolName(toolLog) : pendingToolCall.name),
                });
            } else {
                console.warn(
                    '[SessionTransport] Cannot resolve tool_result, skipping message:',
                    row.id
                );
            }
            continue;
        }

        if (row.role === 'user') {
            flushMissingToolResults();

            const attachments = supportsAttachments
                ? await hydratePersistedAttachments(row.attachments)
                : [];
            const attachmentParts =
                attachments.length > 0 ? await buildAttachmentParts(attachments) : [];

            messages.push({
                role: 'user',
                content:
                    attachmentParts.length > 0
                        ? ([
                              { type: 'text', text: row.content },
                              ...attachmentParts,
                          ] as AiContentPart[])
                        : row.content,
            });
            continue;
        }

        flushMissingToolResults();

        messages.push({
            role: row.role as 'user' | 'assistant' | 'system',
            content: row.role === 'assistant' ? buildAssistantTransportContent(row) : row.content,
        });
    }

    flushMissingToolResults();

    return messages;
}
