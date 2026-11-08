// Copyright (c) 2026. 千诚. Licensed under GPL v3
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';

import { db } from '../index';
import { messageParts, messages, type ToolLogKind } from '../schema';
import type {
    BuiltInToolLogEntity,
    BuiltInToolLogUpdateData,
    McpToolLogEntity,
    McpToolLogUpdateData,
    MessagePartEntity,
} from '../types';

type ToolPartIdentity = 'id' | 'tool_call_id' | 'session_id' | 'message_id' | 'created_at';
/** The JSON payload stored by tool_call parts, not a flattened message or log reference. */
export type ToolCallPartData = { toolCallId: string } & (
    | (Omit<McpToolLogEntity, ToolPartIdentity> & { toolKind: 'mcp' })
    | (Omit<BuiltInToolLogEntity, ToolPartIdentity> & { toolKind: 'builtin' })
);

export function readToolCallData(part: MessagePartEntity): ToolCallPartData {
    return JSON.parse(part.data) as ToolCallPartData;
}

export function getToolCallName(data: ToolCallPartData): string {
    return data.toolKind === 'builtin'
        ? `builtin__${data.tool_id}`
        : `mcp__${data.server_id}__${data.tool_name}`;
}

function toolPayload(data: Record<string, unknown>): Record<string, unknown> {
    const payload = { ...data };
    for (const key of ['message_id', 'session_id', 'tool_call_id', 'created_at'])
        delete payload[key];
    if (typeof data.tool_call_id === 'string') payload.toolCallId = data.tool_call_id;
    return payload;
}

export type ToolPartEntity = McpToolLogEntity | BuiltInToolLogEntity;
export async function findToolParts(
    kind: ToolLogKind,
    condition?: SQL,
    options?: { limit?: number; offset?: number }
): Promise<ToolPartEntity[]> {
    const query = db
        .select({ part: messageParts, session_id: messages.session_id })
        .from(messageParts)
        .innerJoin(messages, eq(messages.id, messageParts.message_id))
        .where(and(eq(messageParts.type, 'tool_call'), eq(messageParts.tool_kind, kind), condition))
        .orderBy(desc(messageParts.created_at), desc(messageParts.id));
    const rows = options
        ? await query
              .limit(options.limit ?? 100)
              .offset(options.offset ?? 0)
              .all()
        : await query.all();
    return rows.map(({ part, session_id }) => toToolPartEntity(part, session_id));
}

function toToolPartEntity(part: MessagePartEntity, sessionId: number | null): ToolPartEntity {
    return {
        ...JSON.parse(part.data),
        id: part.id,
        tool_call_id: part.tool_call_id!,
        session_id: sessionId,
        message_id: part.message_id,
        created_at: part.created_at,
    } as ToolPartEntity;
}

/**
 * 日志列表的轻量投影。
 *
 * 列表只需要展示字段与输入摘要，不再把完整 input/output JSON 拉进内存；
 * 完整正文由 `findToolPartById` 在用户展开时按需读取。
 */
export interface ToolPartSummaryRow {
    id: number;
    tool_call_id: string | null;
    tool_name: string;
    session_id: number | null;
    message_id: number;
    created_at: string;
    status: string;
    duration_ms: number | null;
    server_id: number | null;
    input_preview: string | null;
    output_length: number;
}

/** 按日志主键读取完整工具调用记录。 */
export async function findToolPartById(
    kind: ToolLogKind,
    id: number
): Promise<ToolPartEntity | undefined> {
    const row = await db
        .select({ part: messageParts, session_id: messages.session_id })
        .from(messageParts)
        .innerJoin(messages, eq(messages.id, messageParts.message_id))
        .where(
            and(
                eq(messageParts.id, id),
                eq(messageParts.type, 'tool_call'),
                eq(messageParts.tool_kind, kind)
            )
        )
        .get();

    return row ? toToolPartEntity(row.part, row.session_id) : undefined;
}

/** 按工具类型收集列表摘要，避免读取完整 input/output。 */
export async function findToolPartSummaries(
    kind: ToolLogKind,
    condition?: SQL,
    options?: { limit?: number; offset?: number }
): Promise<ToolPartSummaryRow[]> {
    const toolNameExpression =
        kind === 'builtin'
            ? sql<string | null>`${messageParts.tool_id}`
            : sql<string | null>`json_extract(${messageParts.data}, '$."tool_name"')`;
    const serverIdExpression =
        kind === 'builtin'
            ? sql<number | null>`null`
            : sql<number | null>`${messageParts.server_id}`;

    const query = db
        .select({
            id: messageParts.id,
            message_id: messageParts.message_id,
            session_id: messages.session_id,
            tool_call_id: messageParts.tool_call_id,
            created_at: messageParts.created_at,
            status: sql<string | null>`json_extract(${messageParts.data}, '$."status"')`,
            duration_ms: sql<number | null>`json_extract(${messageParts.data}, '$."duration_ms"')`,
            tool_name: toolNameExpression,
            server_id: serverIdExpression,
            input_preview: sql<
                string | null
            >`substr(coalesce(json_extract(${messageParts.data}, '$."input"'), ''), 1, 200)`,
            output_length: sql<number>`length(coalesce(json_extract(${messageParts.data}, '$."output"'), ''))`,
        })
        .from(messageParts)
        .innerJoin(messages, eq(messages.id, messageParts.message_id))
        .where(and(eq(messageParts.type, 'tool_call'), eq(messageParts.tool_kind, kind), condition))
        .orderBy(desc(messageParts.created_at), desc(messageParts.id));

    const rows = options
        ? await query
              .limit(options.limit ?? 100)
              .offset(options.offset ?? 0)
              .all()
        : await query.all();

    return rows.map((row) => ({
        ...row,
        tool_name: row.tool_name ?? '',
        status: row.status ?? 'pending',
    }));
}
export async function createToolPart(
    kind: ToolLogKind,
    data: Record<string, unknown>
): Promise<ToolPartEntity> {
    /**
     * 串行化写入。
     *
     * 一轮里模型可能并行发出多个工具调用，而 `runToolRound` 用 `Promise.all`
     * 并发执行它们 —— 每个都会走到这里。`message_parts` 上有唯一索引
     * `(message_id, sort_order)`，两个并发事务各自读到同一个 `max(sort_order)`
     * 就会算出同一个序号，后写的那条撞唯一索引、整个事务回滚，
     * 表现就是「工具执行了、UI 也显示了，但重载后这个调用整条不见了」。
     *
     * 序号分配已经在事务内用 `INSERT ... SELECT MAX()` 做原子化；但 WAL + `BEGIN DEFERRED`
     * 下事务内「先读后写」本身还会因读快照升级失败抛 SQLITE_BUSY
     * （已在 `database/driver.ts` 把写事务默认改成 `BEGIN IMMEDIATE` 解决）。
     * 这里保留队列：把同一个进程里的分配串起来，减少写锁争用，也让落库顺序可预期。
     */
    return enqueueToolPartWrite(() => createToolPartInner(kind, data));
}

/** 全局写入队列：保证 `sort_order` 分配不会并发。 */
let toolPartWriteChain: Promise<unknown> = Promise.resolve();

/** 仅供测试：把操作排进与 `createToolPart` 同一个队列。 */
export function enqueueToolPartWrite<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = toolPartWriteChain.then(operation, operation);
    // 单次失败不能阻断后续写入。
    toolPartWriteChain = scheduled.then(
        () => undefined,
        () => undefined
    );
    return scheduled;
}

async function createToolPartInner(
    kind: ToolLogKind,
    data: Record<string, unknown>
): Promise<ToolPartEntity> {
    return db.transaction(async (tx) => {
        let messageId = data.message_id as number | undefined;
        if (!messageId) {
            if (typeof data.session_id !== 'number')
                throw new Error('A tool call must belong to a session');
            const row = await tx
                .insert(messages)
                .values({ session_id: data.session_id, role: 'tool_call' })
                .returning()
                .get();
            if (!row) throw new Error('Failed to create tool message');
            messageId = row.id;
        }
        const { tool_call_id: callId, created_at: createdAt } = data;
        const payload = toolPayload(data);

        /**
         * `sort_order` 必须原子分配。
         *
         * 一轮里的并行工具调用会并发走到这里。先 `select max()` 再 `insert`
         * 会让两个并发事务读到同一个最大值，算出一模一样的 `sort_order`，
         * 后写的那条撞上 `(message_id, sort_order)` 唯一索引并回滚整个事务，
         * 结果就是「执行了但没入库」。
         *
         * 所以改成在一条 INSERT 里用子查询取 max，由 SQLite 在写锁内完成分配。
         */
        const inserted = await tx
            .insert(messageParts)
            .values({
                message_id: messageId,
                type: 'tool_call',
                content: '',
                sort_order: sql<number>`(
                    SELECT COALESCE(MAX(${messageParts.sort_order}), -1) + 1
                    FROM ${messageParts}
                    WHERE ${messageParts.message_id} = ${messageId}
                )`,
                data: JSON.stringify({
                    iteration: 1,
                    output: null,
                    status: 'pending',
                    duration_ms: null,
                    error_message: null,
                    ...(kind === 'builtin'
                        ? {
                              approval_state: 'none',
                              approval_summary: null,
                              conversation_semantic_json: null,
                              structured_payload_json: null,
                          }
                        : {}),
                    ...payload,
                    toolCallId: callId,
                    toolKind: kind,
                }),
                ...(typeof createdAt === 'string' ? { created_at: createdAt } : {}),
            })
            .returning()
            .get();
        const part = inserted;
        if (!part) throw new Error('Failed to persist tool part');
        const parent = await tx.select().from(messages).where(eq(messages.id, messageId)).get();
        return {
            ...JSON.parse(part.data),
            id: part.id,
            tool_call_id: part.tool_call_id!,
            session_id: parent!.session_id,
            message_id: messageId,
            created_at: part.created_at,
        } as ToolPartEntity;
    });
}
export async function updateToolPart(
    kind: ToolLogKind,
    condition: SQL,
    patch: McpToolLogUpdateData | BuiltInToolLogUpdateData
): Promise<ToolPartEntity | undefined> {
    return db.transaction(async (tx) => {
        const existing = await tx
            .select()
            .from(messageParts)
            .where(
                and(eq(messageParts.type, 'tool_call'), eq(messageParts.tool_kind, kind), condition)
            )
            .orderBy(asc(messageParts.id))
            .all();
        let result: ToolPartEntity | undefined;
        for (const part of existing) {
            const payload = toolPayload({ ...patch });
            const updated = await tx
                .update(messageParts)
                .set({
                    data: JSON.stringify({ ...JSON.parse(part.data), ...payload, toolKind: kind }),
                    updated_at: sql`datetime('now')`,
                })
                .where(eq(messageParts.id, part.id))
                .returning()
                .get();
            if (updated && !result) {
                const parent = await tx
                    .select()
                    .from(messages)
                    .where(eq(messages.id, updated.message_id))
                    .get();
                result = {
                    ...JSON.parse(updated.data),
                    id: updated.id,
                    message_id: updated.message_id,
                    session_id: parent!.session_id,
                    tool_call_id: updated.tool_call_id!,
                    created_at: updated.created_at,
                } as ToolPartEntity;
            }
        }
        return result;
    });
}
export const toolData = (field: string) =>
    sql`json_extract(${messageParts.data}, ${'$."' + field + '"'})`;
