// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    findMessagesBySessionId,
    findToolLogRowsBySessionId,
    type ToolLogHistoryRow,
} from '@database/queries/messages';

import {
    hydratePersistedAttachments,
    type Index,
    isAttachmentSupported,
    readAttachmentAsBase64,
    readAttachmentAsText,
} from './attachments';
import type { AiContentPart, AiMessage, AiToolCall } from './types';

interface BuildRequestMessagesOptions {
    prompt: string;
    sessionId?: number;
    attachments?: Index[];
    supportsAttachments?: boolean;
}

async function buildAttachmentParts(attachments: Index[]): Promise<AiContentPart[]> {
    const parts: AiContentPart[] = [];
    // 同一回话的模型可能变化，此处静默跳过当前模型不支持的附件，避免更改模型后整体失败。
    const usableAttachments = attachments.filter((attachment) => isAttachmentSupported(attachment));

    for (const attachment of usableAttachments) {
        try {
            if (attachment.type === 'image') {
                const { data, mimeType } = await readAttachmentAsBase64(attachment);
                parts.push({ type: 'image', mimeType, data });
                continue;
            }

            const { content, isBinary } = await readAttachmentAsText(attachment);
            parts.push({
                type: 'file',
                name: attachment.name,
                content,
                isBinary,
            });
        } catch (error) {
            console.error('[AiServiceManager] Failed to read attachment:', error);
        }
    }

    return parts;
}

/**
 * 将数据库消息与工具日志重组为 AiMessage 数组。
 *
 * 用户消息仍然需要把持久化的附件元数据还原成 provider 可消费的内容块；
 * 工具相关消息则依赖独立的工具日志列表重建 tool_call/tool_result。
 */
async function convertMessageHistory(
    rows: Awaited<ReturnType<typeof findMessagesBySessionId>>,
    toolLogs: ToolLogHistoryRow[],
    supportsAttachments: boolean
): Promise<AiMessage[]> {
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

    for (const row of rows) {
        if (row.role === 'tool_call') {
            const pendingToolCalls: AiToolCall[] =
                toolLogsByMessageId.get(row.id)?.map((toolLog) => ({
                    id: toolLog.tool_call_id,
                    name:
                        toolLog.source === 'builtin'
                            ? `builtin__${toolLog.tool_name}`
                            : toolLog.tool_name,
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
                messages.push({
                    role: 'tool',
                    content: row.content,
                    tool_call_id: toolLog.tool_call_id,
                    name:
                        toolLog.source === 'builtin'
                            ? `builtin__${toolLog.tool_name}`
                            : toolLog.tool_name,
                });
            } else {
                console.warn(
                    '[buildRequestMessages] Cannot resolve tool_result, skipping message:',
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

/**
 * 组装一次模型请求所需消息：会话历史 + 当前用户输入 + 附件。
 *
 * 工具日志独立查询，避免 MCP 与内置工具同时参与历史回放时出现交叉展开。
 */
export async function buildRequestMessages(
    options: BuildRequestMessagesOptions
): Promise<AiMessage[]> {
    const [rows, toolLogs] = options.sessionId
        ? await Promise.all([
              findMessagesBySessionId(options.sessionId),
              findToolLogRowsBySessionId(options.sessionId),
          ])
        : [[], []];
    const supportsAttachments = options.supportsAttachments ?? true;

    const messages = await convertMessageHistory(rows, toolLogs, supportsAttachments);

    // 构建当前用户输入
    const attachmentParts = supportsAttachments
        ? await buildAttachmentParts(options.attachments ?? [])
        : [];
    const userContent =
        attachmentParts.length > 0
            ? ([{ type: 'text', text: options.prompt }, ...attachmentParts] as AiContentPart[])
            : options.prompt;

    messages.push({ role: 'user', content: userContent });
    return messages;
}
