// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, eq } from 'drizzle-orm';

import { db } from '../index';
import { builtInToolLogs, mcpToolLogs, messages } from '../schema';
import type { MessageCreateData, MessageEntity } from '../types';
import { findAttachmentsByMessageIds, type MessageAttachmentRow } from './attachments';

export interface ToolLogHistoryRow {
    source: 'mcp' | 'builtin';
    log_id: number;
    tool_call_id: string;
    tool_name: string;
    tool_input: string;
    message_id: number | null;
    created_at: string;
    tool_status: string;
    tool_duration_ms: number | null;
    server_id: number | null;
}

export interface MessageRow extends MessageEntity {
    attachments: MessageAttachmentRow[];
    tool_call_id: string | null;
    tool_name: string | null;
    tool_input: string | null;
    tool_log_ref_id: number | null;
    tool_status: string | null;
    tool_duration_ms: number | null;
    server_id: number | null;
}

function toNamespacedToolName(toolLog: ToolLogHistoryRow): string {
    return toolLog.source === 'builtin' ? `builtin__${toolLog.tool_name}` : toolLog.tool_name;
}

function buildMessageRow(
    row: MessageEntity,
    attachments: MessageAttachmentRow[],
    toolLog?: ToolLogHistoryRow
): MessageRow {
    return {
        ...row,
        tool_log_id: toolLog?.log_id ?? row.tool_log_id,
        tool_log_kind: toolLog?.source ?? row.tool_log_kind,
        attachments,
        tool_call_id: toolLog?.tool_call_id ?? null,
        tool_name: toolLog ? toNamespacedToolName(toolLog) : null,
        tool_input: toolLog?.tool_input ?? null,
        tool_log_ref_id: toolLog?.log_id ?? null,
        tool_status: toolLog?.tool_status ?? null,
        tool_duration_ms: toolLog?.tool_duration_ms ?? null,
        server_id: toolLog?.server_id ?? null,
    };
}

/**
 * 根据会话 ID 查找所有消息。
 *
 * 消息、附件与工具日志分开存储，这里先分别拉取三类数据，
 * 再在内存中按 message 重组，避免双表 LEFT JOIN 带来的笛卡尔积问题。
 *
 * @param sessionId 会话主键 ID。
 * @returns 带工具日志辅助信息的扁平消息行。
 */
export const findMessagesBySessionId = async (sessionId: number): Promise<MessageRow[]> => {
    const baseRows = await db
        .getDb()
        .select()
        .from(messages)
        .where(eq(messages.session_id, sessionId))
        .orderBy(asc(messages.created_at), asc(messages.id))
        .all();

    if (baseRows.length === 0) {
        return [];
    }

    const [attachmentRows, toolLogs] = await Promise.all([
        findAttachmentsByMessageIds(Array.from(new Set(baseRows.map((row) => row.id)))),
        findToolLogRowsBySessionId(sessionId),
    ]);

    const attachmentsByMessageId = new Map<number, MessageAttachmentRow[]>();
    const toolLogsByMessageId = new Map<number, ToolLogHistoryRow[]>();
    const toolLogByIdentity = new Map<string, ToolLogHistoryRow>();

    for (const attachmentRow of attachmentRows) {
        const existing = attachmentsByMessageId.get(attachmentRow.message_id) ?? [];
        existing.push(attachmentRow);
        attachmentsByMessageId.set(attachmentRow.message_id, existing);
    }

    for (const toolLog of toolLogs) {
        if (toolLog.message_id !== null) {
            const existing = toolLogsByMessageId.get(toolLog.message_id) ?? [];
            existing.push(toolLog);
            toolLogsByMessageId.set(toolLog.message_id, existing);
        }

        toolLogByIdentity.set(`${toolLog.source}:${toolLog.log_id}`, toolLog);
    }

    const rows: MessageRow[] = [];
    const pendingToolResultQueue: ToolLogHistoryRow[] = [];

    /**
     * 某些异常写入会留下缺失 tool_log_id 的 tool_result，但同轮 tool_call 日志仍然在库里。
     *
     * 这里按时间顺序维护一个“待消费工具结果队列”，让历史会话在读取时可以把
     * 缺失引用的 tool_result 配回对应 tool_call，避免续聊时丢失 tool_call_id。
     */
    const takeQueuedToolLog = (
        source?: ToolLogHistoryRow['source']
    ): ToolLogHistoryRow | undefined => {
        if (!source) {
            return pendingToolResultQueue.shift();
        }

        const queueIndex = pendingToolResultQueue.findIndex((toolLog) => toolLog.source === source);
        if (queueIndex < 0) {
            return undefined;
        }

        const [toolLog] = pendingToolResultQueue.splice(queueIndex, 1);
        return toolLog;
    };

    const removeQueuedToolLog = (toolLog: ToolLogHistoryRow): void => {
        const queueIndex = pendingToolResultQueue.findIndex((queuedToolLog) => {
            return (
                queuedToolLog.source === toolLog.source && queuedToolLog.log_id === toolLog.log_id
            );
        });

        if (queueIndex >= 0) {
            pendingToolResultQueue.splice(queueIndex, 1);
        }
    };

    for (const row of baseRows) {
        const attachments = attachmentsByMessageId.get(row.id) ?? [];

        if (row.role === 'tool_call') {
            // 一条 tool_call 消息可以对应多个日志，因此这里按日志展开成多行，
            // 让现有历史恢复逻辑继续按 message id 分组消费。
            const messageToolLogs = toolLogsByMessageId.get(row.id) ?? [];

            if (messageToolLogs.length === 0) {
                rows.push(buildMessageRow(row, attachments));
                continue;
            }

            pendingToolResultQueue.push(...messageToolLogs);
            rows.push(
                ...messageToolLogs.map((toolLog) => buildMessageRow(row, attachments, toolLog))
            );
            continue;
        }

        if (row.role === 'tool_result') {
            const toolSource = row.tool_log_kind ?? 'mcp';
            const resolvedById =
                row.tool_log_id !== null
                    ? toolLogByIdentity.get(`${toolSource}:${row.tool_log_id}`)
                    : undefined;
            if (resolvedById) {
                removeQueuedToolLog(resolvedById);
            }

            const toolLog = resolvedById ?? takeQueuedToolLog(row.tool_log_kind ?? undefined);

            rows.push(buildMessageRow(row, attachments, toolLog));
            continue;
        }

        rows.push(buildMessageRow(row, attachments));
    }

    return rows;
};

/**
 * 查询会话内所有工具日志，并统一映射成历史重放所需的扁平结构。
 *
 * MCP 与内置工具日志分表存储，因此这里先分别查询再合并排序，
 * 供历史回放或消息重建逻辑复用。
 *
 * @param sessionId 会话主键 ID。
 * @returns 按发生顺序排序后的工具日志行。
 */
export const findToolLogRowsBySessionId = async (
    sessionId: number
): Promise<ToolLogHistoryRow[]> => {
    const [mcpRows, builtInRows] = await Promise.all([
        db
            .getDb()
            .select({
                log_id: mcpToolLogs.id,
                tool_call_id: mcpToolLogs.tool_call_id,
                tool_name: mcpToolLogs.tool_name,
                tool_input: mcpToolLogs.input,
                message_id: mcpToolLogs.message_id,
                created_at: mcpToolLogs.created_at,
                tool_status: mcpToolLogs.status,
                tool_duration_ms: mcpToolLogs.duration_ms,
                server_id: mcpToolLogs.server_id,
            })
            .from(mcpToolLogs)
            .where(eq(mcpToolLogs.session_id, sessionId))
            .all(),
        db
            .getDb()
            .select({
                log_id: builtInToolLogs.id,
                tool_call_id: builtInToolLogs.tool_call_id,
                tool_name: builtInToolLogs.tool_id,
                tool_input: builtInToolLogs.input,
                message_id: builtInToolLogs.message_id,
                created_at: builtInToolLogs.created_at,
                tool_status: builtInToolLogs.status,
                tool_duration_ms: builtInToolLogs.duration_ms,
            })
            .from(builtInToolLogs)
            .where(eq(builtInToolLogs.session_id, sessionId))
            .all(),
    ]);

    return [
        ...mcpRows.map((row) => ({ ...row, source: 'mcp' as const })),
        ...builtInRows.map((row) => ({ ...row, source: 'builtin' as const, server_id: null })),
    ].sort((left, right) => {
        if (left.created_at === right.created_at) {
            return left.log_id - right.log_id;
        }

        return left.created_at.localeCompare(right.created_at);
    });
};

/**
 * 创建消息。
 *
 * @param data 消息初始数据。
 * @returns 新创建的消息记录。
 */
export const createMessage = async (data: MessageCreateData): Promise<MessageEntity> => {
    const createdMessage = await db.getDb().insert(messages).values(data).returning().get();

    if (!createdMessage || createdMessage.id === undefined) {
        throw new Error('Failed to create message');
    }

    return createdMessage;
};

/**
 * 统计所有消息数。
 *
 * @returns 当前数据库中的消息总数。
 */
export const countMessages = async (): Promise<number> => {
    const result = await db.getDb().select({ count: count() }).from(messages).get();

    return result?.count || 0;
};

/**
 * 删除所有消息。
 *
 * @returns 无。
 */
export const deleteAllMessages = async (): Promise<void> => {
    await db.getDb().delete(messages).run();
};
