// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { db } from '@database';
import { messageParts, sessionTurns } from '@database/schema';
import { installTauriMocks, interceptTauriInvoke } from '@tests/utils/tauri';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 数据库驱动把查询结果从「对象」还原成「按列顺序的数组」。
 *
 * 历史实现只按 SQL 文本推断列名，遇到没有别名的表达式列
 * （`select coalesce(max("sort_order"), -1) …`）会把
 * `sort_order` 当成列名，于是取不到值、返回 null —— 调用级用量
 * 的 `sort_order` 因此恒为 0，与已有片段撞唯一索引，整个事务回滚。
 *
 * 这些用例锁住修复后的行为：以数据库返回行自身的键顺序为准。
 */
describe('when a query result is mapped back to its selected columns', () => {
    beforeEach(() => {
        installTauriMocks();
    });

    afterEach(() => {
        installTauriMocks();
    });

    function respondRows(rows: Array<Record<string, unknown>>) {
        interceptTauriInvoke((call) => {
            if (call.cmd !== 'database_query') {
                return undefined;
            }
            return { rows };
        });
    }

    it('user gets the aggregate value under the column the query asked for', async () => {
        // SQLite 用表达式原文当列名；SQL 文本解析会错认成 "sort_order"。
        respondRows([{ 'coalesce(max("message_parts"."sort_order"), -1)': 7 }]);

        const row = await db
            .select({ value: sql<number>`coalesce(max(${messageParts.sort_order}), -1)` })
            .from(messageParts)
            .where(eq(messageParts.message_id, 1))
            .get();

        expect(row?.value).toBe(7);
    });

    it('user gets multi-column results in the order the query asked for', async () => {
        respondRows([
            {
                'count(*)': 3,
                'coalesce(sum("session_turns"."input_tokens"), 0)': 1200,
                'coalesce(sum("session_turns"."output_tokens"), 0)': 450,
            },
        ]);

        const row = await db
            .select({
                requests: sql<number>`count(*)`,
                inputTokens: sql<number>`coalesce(sum(${sessionTurns.input_tokens}), 0)`,
                outputTokens: sql<number>`coalesce(sum(${sessionTurns.output_tokens}), 0)`,
            })
            .from(sessionTurns)
            .get();

        expect(row).toEqual({ requests: 3, inputTokens: 1200, outputTokens: 450 });
    });

    it('user gets aliased values even when the driver returns fewer keys than asked', async () => {
        // LEFT JOIN 缺列等场景由 SQL 解析结果兜底：缺的列补 null。
        respondRows([{ id: 1 }]);

        const rows = await db
            .select({
                id: sessionTurns.id,
                tokens: sql<number>`coalesce(${sessionTurns.input_tokens}, 0)`,
            })
            .from(sessionTurns)
            .all();

        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(1);
    });
});
