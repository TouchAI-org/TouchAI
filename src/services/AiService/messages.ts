// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findMessagesBySessionId, type MessageRow } from '@database/queries/messages';

import {
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
}

async function buildAttachmentParts(attachments: Index[]): Promise<AiContentPart[]> {
    const parts: AiContentPart[] = [];
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
 * 将 LEFT JOIN 的扁平行按 message 分组，转换为 AiMessage 数组。
 */
function convertJoinedRows(rows: MessageRow[]): AiMessage[] {
    const messages: AiMessage[] = [];
    let lastMsgId = -1;
    let pendingToolCalls: AiToolCall[] = [];

    for (const row of rows) {
        if (row.role === 'tool_call') {
            // 同一条 tool_call 消息可能展开为多行（多个 tool_log）
            if (row.id !== lastMsgId) {
                pendingToolCalls = [];
                lastMsgId = row.id;

                // 收集当前行的 tool_log
                if (row.tool_call_id && row.tool_name) {
                    pendingToolCalls.push({
                        id: row.tool_call_id,
                        name: row.tool_name,
                        arguments: row.tool_input ?? '{}',
                    });
                }

                // 先占位 push，后面同 id 的行会追加到 tool_calls
                messages.push({
                    role: 'assistant',
                    content: row.content,
                    tool_calls: pendingToolCalls,
                });
            } else {
                // 同一条 tool_call 消息的后续 tool_log 行
                if (row.tool_call_id && row.tool_name) {
                    pendingToolCalls.push({
                        id: row.tool_call_id,
                        name: row.tool_name,
                        arguments: row.tool_input ?? '{}',
                    });
                }
            }
        } else if (row.role === 'tool_result') {
            lastMsgId = row.id;
            if (row.tool_call_id && row.tool_name) {
                messages.push({
                    role: 'tool',
                    content: row.content,
                    tool_call_id: row.tool_call_id,
                    name: row.tool_name,
                });
            } else {
                console.warn(
                    '[buildRequestMessages] Cannot resolve tool_result, skipping message:',
                    row.id
                );
            }
        } else {
            lastMsgId = row.id;
            messages.push({
                role: row.role as 'user' | 'assistant' | 'system',
                content: row.content,
            });
        }
    }

    return messages;
}

/**
 * 组装一次模型请求所需消息：会话历史 + 当前用户输入 + 附件。
 *
 * 通过一次 LEFT JOIN 查询获取消息及关联的 tool_log，避免 N+1 查询。
 */
export async function buildRequestMessages(
    options: BuildRequestMessagesOptions
): Promise<AiMessage[]> {
    const rows = options.sessionId ? await findMessagesBySessionId(options.sessionId) : [];

    const messages = convertJoinedRows(rows);

    // 构建当前用户输入
    const attachmentParts = await buildAttachmentParts(options.attachments ?? []);
    const userContent =
        attachmentParts.length > 0
            ? ([{ type: 'text', text: options.prompt }, ...attachmentParts] as AiContentPart[])
            : options.prompt;

    messages.push({ role: 'user', content: userContent });
    return messages;
}
