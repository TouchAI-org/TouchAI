// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    findMessagesBySessionId,
    findToolLogRowsBySessionId,
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

    for (const toolLog of toolLogs) {
        if (toolLog.message_id !== null) {
            const messageLogs = toolLogsByMessageId.get(toolLog.message_id) ?? [];
            messageLogs.push(toolLog);
            toolLogsByMessageId.set(toolLog.message_id, messageLogs);
        }

        toolLogByIdentity.set(`${toolLog.source}:${toolLog.log_id}`, toolLog);
    }

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex]!;

        if (row.role === 'tool_call') {
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
                    content: row.content,
                    tool_calls: pendingToolCalls,
                });
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
                content: row.content,
                tool_calls: pendingToolCalls,
            });
            continue;
        }

        if (row.role === 'tool_result') {
            const toolSource = row.tool_log_kind ?? 'mcp';
            const toolLog =
                row.tool_log_id !== null
                    ? toolLogByIdentity.get(`${toolSource}:${row.tool_log_id}`)
                    : undefined;

            if (toolLog) {
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
                    tool_call_id: row.tool_call_id ?? toolLog.tool_call_id,
                    name: row.tool_name ?? toTransportToolName(toolLog),
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

        messages.push({
            role: row.role as 'user' | 'assistant' | 'system',
            content: row.content,
        });
    }

    return messages;
}
