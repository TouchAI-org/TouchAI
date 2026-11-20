// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { type DatabaseExecutor, db } from '@database';
import { insertPreparedLlmCallParts } from '@database/queries/llmCallParts';

import { buildLlmCallPartData, type PersistedCall } from './callParts';

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
    database: DatabaseExecutor = db,
    /** 所属回合 id，写进片段载荷以便调用账本按回合筛选 */
    turnId: number | null = null
): Promise<void> {
    await insertPreparedLlmCallParts(
        messageId,
        calls.map((item) => ({
            data: JSON.stringify(buildLlmCallPartData(item, turnId)),
            durationMs: item.record.timing.durationMs,
            ...(item.record.timing.ttftMs === undefined
                ? {}
                : { ttftMs: item.record.timing.ttftMs }),
        })),
        database
    );
}
