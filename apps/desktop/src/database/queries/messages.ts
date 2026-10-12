// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, eq, sql } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import type { PersistedToolLogStatus } from '../schema';
import { messages } from '../schema';
import type { MessageCreateData, MessageEntity, MessagePartEntity } from '../types';
import { findAttachmentsByMessageIds, type MessageAttachmentRow } from './attachments';
import { findMessagePartsByMessageIds } from './messageParts';

export interface ToolLogHistoryRow {
    source: 'mcp' | 'builtin';
    log_id: number;
    tool_call_id: string;
    tool_name: string;
    tool_input: string;
    message_id: number | null;
    created_at: string;
    tool_status: PersistedToolLogStatus;
    tool_duration_ms: number | null;
    server_id: number | null;
    builtin_conversation_semantic_json: string | null;
}

export interface MessageRow extends MessageEntity {
    /** 有序的模型输出片段；reasoning 与 text 均来自此处。 */
    parts: MessagePartEntity[];
    tool_log_id: number | null;
    tool_log_kind: 'mcp' | 'builtin' | null;
    /** 从 parts 派生的显示摘要，不是独立存储格式。 */
    reasoning: string | null;
    attachments: MessageAttachmentRow[];
    tool_call_id: string | null;
    tool_name: string | null;
    tool_input: string | null;
    tool_log_ref_id: number | null;
    tool_status: PersistedToolLogStatus | null;
    tool_duration_ms: number | null;
    server_id: number | null;
    builtin_conversation_semantic_json: string | null;
}

import { findToolParts } from './toolParts';

function toNamespacedToolName(toolLog: ToolLogHistoryRow): string {
    return toolLog.source === 'builtin'
        ? `builtin__${toolLog.tool_name}`
        : toolLog.server_id !== null
          ? `mcp__${toolLog.server_id}__${toolLog.tool_name}`
          : toolLog.tool_name;
}
export function findToolLogByReference(
    toolLogs: ReadonlyMap<string, ToolLogHistoryRow>,
    id: number | null,
    kind: 'mcp' | 'builtin' | null
): ToolLogHistoryRow | undefined {
    return id === null || kind === null ? undefined : toolLogs.get(`${kind}:${id}`);
}

function buildMessageRow(
    row: Omit<MessageEntity, 'content'>,
    parts: MessagePartEntity[],
    attachments: MessageAttachmentRow[],
    toolLog?: ToolLogHistoryRow
): MessageRow {
    return {
        ...row,
        content: parts
            .filter((part) => part.type === 'text' || part.type === 'tool_result')
            .map((part) => part.content)
            .join(''),
        parts,
        reasoning:
            parts
                .filter((part) => part.type === 'reasoning')
                .map((part) => part.content)
                .join('') || null,
        attachments,
        tool_log_id: toolLog?.log_id ?? null,
        tool_log_kind: toolLog?.source ?? null,
        tool_call_id: toolLog?.tool_call_id ?? null,
        tool_name: toolLog ? toNamespacedToolName(toolLog) : null,
        tool_input: toolLog?.tool_input ?? null,
        tool_log_ref_id: toolLog?.log_id ?? null,
        tool_status: toolLog?.tool_status ?? null,
        tool_duration_ms: toolLog?.tool_duration_ms ?? null,
        server_id: toolLog?.server_id ?? null,
        builtin_conversation_semantic_json: toolLog?.builtin_conversation_semantic_json ?? null,
    };
}
export async function findMessagesBySessionId(sessionId: number): Promise<MessageRow[]> {
    const raw = await db
        .select()
        .from(messages)
        .where(eq(messages.session_id, sessionId))
        .orderBy(asc(messages.id))
        .all();
    const ids = raw.map((row) => row.id);
    const [parts, attachments, logs] = await Promise.all([
        findMessagePartsByMessageIds(ids),
        findAttachmentsByMessageIds(ids),
        findToolLogRowsBySessionId(sessionId),
    ]);
    const byCall = new Map(logs.map((log) => [`${log.source}:${log.tool_call_id}`, log]));
    const partsByMessage = new Map<number, MessagePartEntity[]>();
    for (const part of parts) {
        const current = partsByMessage.get(part.message_id);
        if (current) current.push(part);
        else partsByMessage.set(part.message_id, [part]);
    }
    const attachmentsByMessage = new Map<number, MessageAttachmentRow[]>();
    for (const attachment of attachments) {
        const current = attachmentsByMessage.get(attachment.message_id);
        if (current) current.push(attachment);
        else attachmentsByMessage.set(attachment.message_id, [attachment]);
    }
    const logsByMessage = new Map<number, ToolLogHistoryRow[]>();
    for (const log of logs) {
        if (log.message_id === null) continue;
        const current = logsByMessage.get(log.message_id);
        if (current) current.push(log);
        else logsByMessage.set(log.message_id, [log]);
    }
    return raw.flatMap((row) => {
        const ownParts = partsByMessage.get(row.id) ?? [];
        const ownAttachments = attachmentsByMessage.get(row.id) ?? [];
        if (row.role === 'tool_call') {
            const calls = logsByMessage.get(row.id) ?? [];
            return calls.length
                ? calls.map((log) => buildMessageRow(row, ownParts, ownAttachments, log))
                : [buildMessageRow(row, ownParts, ownAttachments)];
        }
        const result = ownParts.find((part) => part.type === 'tool_result');
        return [
            buildMessageRow(
                row,
                ownParts,
                ownAttachments,
                result?.tool_kind && result.tool_call_id
                    ? byCall.get(`${result.tool_kind}:${result.tool_call_id}`)
                    : undefined
            ),
        ];
    });
}
export async function findToolLogRowsBySessionId(sessionId: number): Promise<ToolLogHistoryRow[]> {
    const [mcp, builtin] = await Promise.all([
        findToolParts('mcp', eq(messages.session_id, sessionId)),
        findToolParts('builtin', eq(messages.session_id, sessionId)),
    ]);
    return [
        ...mcp.map((log) => ({ ...log, source: 'mcp' as const })),
        ...builtin.map((log) => ({ ...log, source: 'builtin' as const })),
    ]
        .map((log) => ({
            source: log.source,
            log_id: log.id,
            tool_call_id: log.tool_call_id,
            tool_name: 'tool_name' in log ? log.tool_name : log.tool_id,
            tool_input: log.input,
            message_id: log.message_id,
            created_at: log.created_at,
            tool_status: log.status,
            tool_duration_ms: log.duration_ms,
            server_id: 'server_id' in log ? log.server_id : null,
            builtin_conversation_semantic_json:
                'conversation_semantic_json' in log ? log.conversation_semantic_json : null,
        }))
        .sort((a, b) => a.log_id - b.log_id);
}
/**
 * 创建消息。
 *
 * @param data 消息初始数据。
 * @returns 新创建的消息记录。
 */
export const createMessage = async (
    data: MessageCreateData,
    database: DatabaseExecutor = db
): Promise<Omit<MessageEntity, 'content'>> => {
    const createdMessage = await database.insert(messages).values(data).returning().get();

    if (!createdMessage || createdMessage.id === undefined) {
        throw new Error('Failed to create message');
    }

    return createdMessage;
};

/** 更新消息身份；正文由 message_parts 保存。 */
export const updateMessage = async (
    messageId: number,
    patch: Partial<Pick<MessageEntity, 'role'>>,
    database: DatabaseExecutor = db
): Promise<void> => {
    await database
        .update(messages)
        .set({ ...patch, updated_at: sql`datetime('now')` })
        .where(eq(messages.id, messageId))
        .run();
};

/**
 * 统计所有消息数。
 *
 * @returns 当前数据库中的消息总数。
 */
export const countMessages = async (): Promise<number> => {
    const result = await db.select({ count: count() }).from(messages).get();

    return result?.count || 0;
};

/**
 * 删除所有消息。
 *
 * @returns 无。
 */
export const deleteAllMessages = async (): Promise<void> => {
    await db.delete(messages).run();
};
