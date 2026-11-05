// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@services/NativeService';

import { buildLlmCallPartData, type PersistedCall } from './callParts';

/**
 * 为一次回合的响应消息插入 `llm_call` 片段。
 *
 * Rust 在一个事务里读取当前最大 sort_order 并追加全部调用，避免并发写入
 * 产生重复顺序号。片段正文为空，只作为用量明细的载体。
 */
export async function insertLlmCallParts(
    messageId: number,
    calls: ReadonlyArray<PersistedCall>,
    turnId: number | null = null
): Promise<void> {
    if (calls.length === 0) {
        return;
    }

    const now = Date.now();
    const payload = calls.map((item) => {
        const { durationMs, ttftMs } = item.record.timing;
        const startedAt = ttftMs === undefined ? null : now - durationMs;
        return {
            data: JSON.stringify(buildLlmCallPartData(item, turnId)),
            startedAt,
            endedAt: startedAt === null ? null : startedAt + durationMs,
        };
    });

    await native.database.operation({
        kind: 'usage_append_llm_call_parts',
        messageId,
        calls: payload,
    });
}
