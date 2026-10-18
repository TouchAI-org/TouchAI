// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { type DatabaseExecutor, db } from '@database';
import { messageParts } from '@database/schema';
import { eq, sql } from 'drizzle-orm';

import { buildLlmCallPartData, type PersistedCall } from './index';

/**
 * 为一次回合的响应消息插入 `llm_call` 片段。
 *
 * 每次 LLM 调用一个片段，`sort_order` 接在现有片段之后。
 * 片段正文为空、不参与 UI 渲染，只作为用量明细的载体，
 * 供调用级查询（表达式索引）与单次调用详情使用。
 *
 * `started_at` / `ended_at` 用 ttft 反推，便于按时间排序与走索引；
 * 无 ttft（非流式或供应商未返回）时留空。
 */
export async function insertLlmCallParts(
    messageId: number,
    calls: ReadonlyArray<PersistedCall>,
    database: DatabaseExecutor = db
): Promise<void> {
    if (calls.length === 0) {
        return;
    }

    const maxRow = await database
        .select({ value: sql<number>`coalesce(max(${messageParts.sort_order}), -1)` })
        .from(messageParts)
        .where(eq(messageParts.message_id, messageId))
        .get();

    const baseOrder = (maxRow?.value ?? -1) + 1;
    const now = Date.now();

    // 逐行插入。一个回合通常只有 1–3 次调用，逐行写成本可忽略；
    // 且单行语句能直观看懂冲突是哪一条（多行 `values([...])` 的报错看不出行号）。
    for (const [index, item] of calls.entries()) {
        const { durationMs, ttftMs } = item.record.timing;
        const startedAt = ttftMs === undefined ? null : now - durationMs;

        await database
            .insert(messageParts)
            .values({
                message_id: messageId,
                type: 'llm_call' as const,
                content: '',
                data: JSON.stringify(buildLlmCallPartData(item)),
                started_at: startedAt,
                ended_at: startedAt === null ? null : startedAt + durationMs,
                sort_order: baseOrder + index,
            })
            .run();
    }
}
