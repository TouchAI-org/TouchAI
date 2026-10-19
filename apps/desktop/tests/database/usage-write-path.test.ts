import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { updateSessionTurnAttemptUsage } from '@database/queries/sessionTurnAttempts';
import { updateSessionTurnUsage } from '@database/queries/sessionTurns';
import { getUsageCallPage, getUsageSummary } from '@database/queries/usageStats';
import type { PersistedCall } from '@services/UsageService';
import { insertLlmCallParts } from '@services/UsageService/insertLlmCallParts';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const databaseRoot = resolve('src/database');
const journal = JSON.parse(readFileSync(`${databaseRoot}/drizzle/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
};

const databases: SqliteDatabase[] = [];

function openDatabase(): SqliteDatabase {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    for (const entry of journal.entries) {
        database.exec(readFileSync(`${databaseRoot}/drizzle/${entry.tag}.sql`, 'utf8'));
    }
    return database;
}

/**
 * 把 Tauri SQL 调用转接到真实 SQLite。
 *
 * `node:sqlite` 返回的列顺序与 SELECT 一致，与 Rust 侧开启
 * `serde_json` 的 `preserve_order` 之后的行为相同，因此这条路径
 * 能真实复现驱动层的列映射逻辑。
 */
function routeQueriesTo(database: SqliteDatabase) {
    interceptTauriInvoke((call) => {
        if (call.cmd === 'database_tx_begin') {
            database.exec('BEGIN');
            return 'test-tx';
        }
        if (call.cmd === 'database_tx_commit') {
            database.exec('COMMIT');
            return null;
        }
        if (call.cmd === 'database_tx_rollback') {
            database.exec('ROLLBACK');
            return null;
        }
        if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') return undefined;

        const { request } = call.payload as {
            request: { sql: string; params: SQLInputValue[]; method: string };
        };
        const statement = database.prepare(request.sql);
        if (request.method === 'run') {
            const result = statement.run(...(request.params ?? []));
            return {
                rows: [],
                rowsAffected: Number(result.changes),
                lastInsertId: Number(result.lastInsertRowid),
            };
        }
        return {
            rows: statement.all(...(request.params ?? [])),
            rowsAffected: 0,
            lastInsertId: null,
        };
    });
}

/** 建一条最小的 provider / model / session / message / turn / attempt 链路 */
function seed(database: SqliteDatabase) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Magpie', 'openai-compatible', 'http://127.0.0.1:3425/v1', 'openai');
        INSERT INTO models (id, provider_id, name, model_id, context_limit)
        VALUES (1, 1, 'Auto Flash', 'group/auto-deepseek-v4-1-flash', 1000000);
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'session-1', 'Test Session', 'group/auto-deepseek-v4-1-flash', 1);
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant');
        INSERT INTO session_turns (id, session_id, model_id, task_id, prompt_snapshot_json, status)
        VALUES (1, 1, 1, 'task-1', '{}', 'streaming');
        INSERT INTO session_turn_attempts (id, turn_id, attempt_index, checkpoint_json, delivery_manifest_json, status)
        VALUES (1, 1, 1, '{}', '{}', 'streaming');
    `);
}

function call(overrides: Partial<PersistedCall['record']> = {}): PersistedCall {
    return {
        record: {
            iteration: 0,
            modelId: 1,
            modelName: 'group/auto-deepseek-v4-1-flash',
            providerId: 1,
            providerName: 'Magpie',
            usage: {
                inputTokens: 191,
                outputTokens: 11,
                cacheReadTokens: 9216,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
            },
            timing: { ttftMs: 1892, firstTextMs: 1900, flowMs: 76, durationMs: 2229 },
            finishReason: 'stop',
            errorMessage: undefined,
            toolCallsInStep: 0,
            toolArgumentErrors: 0,
            ...overrides,
        },
        cost: {
            inputCostMicros: 0,
            outputCostMicros: 0,
            cacheReadCostMicros: 0,
            cacheWriteCostMicros: 0,
            reasoningCostMicros: 0,
            totalCostMicros: 0,
            currency: 'USD',
            pricingModel: null,
            appliedTierAbove: null,
            priced: false,
        },
    };
}

const WIDE_RANGE = { from: '1970-01-01 00:00:00', to: '9999-12-31 23:59:59' };

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('usage write path against a real database', () => {
    it('appends llm_call parts after the existing text parts without a sort_order clash', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // 回合正文已经占了 sort_order 0（真实场景由 persistOutputProgress 写入）
        database.exec(`
            INSERT INTO message_parts (id, message_id, type, content, sort_order)
            VALUES (1, 1, 'text', '你好，我是 TouchAI。', 0);
        `);

        await insertLlmCallParts(1, [call()], (await import('@database')).db);

        const rows = database
            .prepare(
                'SELECT type, sort_order FROM message_parts WHERE message_id = 1 ORDER BY sort_order'
            )
            .all() as Array<{ type: string; sort_order: number }>;

        expect(rows).toEqual([
            { type: 'text', sort_order: 0 },
            { type: 'llm_call', sort_order: 1 },
        ]);
    });

    it('continues numbering when a turn makes several calls in a row', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        database.exec(`
            INSERT INTO message_parts (id, message_id, type, content, sort_order)
            VALUES (1, 1, 'text', '正文', 0);
        `);

        await insertLlmCallParts(
            1,
            [call({ iteration: 0 }), call({ iteration: 1 }), call({ iteration: 2 })],
            (await import('@database')).db
        );

        const orders = database
            .prepare(
                "SELECT sort_order FROM message_parts WHERE type = 'llm_call' ORDER BY sort_order"
            )
            .all() as Array<{ sort_order: number }>;

        expect(orders.map((row) => row.sort_order)).toEqual([1, 2, 3]);
    });

    it('aggregates the same call in both the attempt and the turn', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const { db } = await import('@database');
        await insertLlmCallParts(1, [call()], db);
        await updateSessionTurnAttemptUsage({
            id: 1,
            usagePatch: {
                input_tokens: 191,
                output_tokens: 11,
                cache_read_tokens: 9216,
                cache_write_tokens: 0,
                reasoning_tokens: 0,
                total_cost_micros: 0,
                unpriced_calls: 1,
                ttft_ms: 1892,
                llm_call_count: 1,
            },
            database: db,
        });

        const attempt = database
            .prepare(
                'SELECT input_tokens, cache_read_tokens, llm_call_count, ttft_ms FROM session_turn_attempts WHERE id = 1'
            )
            .get() as Record<string, number>;
        expect(attempt).toMatchObject({
            input_tokens: 191,
            cache_read_tokens: 9216,
            llm_call_count: 1,
            ttft_ms: 1892,
        });

        // 回合级用子查询汇总 attempt，避免双写漂移
        await updateSessionTurnUsage({
            id: 1,
            usagePatch: {
                input_tokens: 191,
                output_tokens: 11,
                cache_read_tokens: 9216,
                cache_write_tokens: 0,
                reasoning_tokens: 0,
                total_cost_micros: 0,
                unpriced_calls: 1,
                llm_call_count: 1,
                ttft_ms: 1892,
            },
            database: db,
        });

        const summary = await getUsageSummary(WIDE_RANGE);
        expect(summary.requestCount).toBe(1);
        expect(summary.inputTokens).toBe(191);
        expect(summary.outputTokens).toBe(11);
        expect(summary.cacheReadTokens).toBe(9216);
        expect(summary.realTotalTokens).toBe(191 + 11 + 9216);
        expect(summary.meanTtftMs).toBe(1892);
        expect(summary.unpricedCount).toBe(1);
    });

    it('reads the call ledger back with its usage and timing', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const { db } = await import('@database');
        await insertLlmCallParts(1, [call()], db);

        const page = await getUsageCallPage(WIDE_RANGE, 0, 20);

        expect(page.total).toBe(1);
        const row = page.rows[0]!;
        expect(row.modelName).toBe('group/auto-deepseek-v4-1-flash');
        expect(row.providerName).toBe('Magpie');
        expect(row.inputTokens).toBe(191);
        expect(row.cacheReadTokens).toBe(9216);
        expect(row.ttftMs).toBe(1892);
        expect(row.durationMs).toBe(2229);
        expect(row.finishReason).toBe('stop');
        expect(row.priced).toBe(false);
        expect(row.sessionTitle).toBe('Test Session');
    });

    it('filters the ledger by the owning turn status', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const { db } = await import('@database');
        await insertLlmCallParts(1, [call()], db, 1);

        database.exec(`UPDATE session_turns SET status = 'failed' WHERE id = 1`);

        const failed = await getUsageCallPage({ ...WIDE_RANGE, statuses: ['failed'] }, 0, 20);
        expect(failed.total).toBe(1);

        const completed = await getUsageCallPage({ ...WIDE_RANGE, statuses: ['completed'] }, 0, 20);
        expect(completed.total).toBe(0);
    });

    it('filters the ledger by model and provider from the part payload', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const { db } = await import('@database');
        await insertLlmCallParts(1, [call()], db, 1);

        const matching = await getUsageCallPage(
            { ...WIDE_RANGE, modelIds: [1], providerIds: [1] },
            0,
            20
        );
        expect(matching.total).toBe(1);

        const wrongModel = await getUsageCallPage({ ...WIDE_RANGE, modelIds: [2] }, 0, 20);
        expect(wrongModel.total).toBe(0);
    });

    it('keeps the cost columns when the call is priced', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const priced = call();
        priced.cost = {
            inputCostMicros: 29,
            outputCostMicros: 7,
            cacheReadCostMicros: 14,
            cacheWriteCostMicros: 0,
            reasoningCostMicros: 0,
            totalCostMicros: 50,
            currency: 'USD',
            pricingModel: 'deepseek-v4-flash',
            appliedTierAbove: null,
            priced: true,
        };

        const { db } = await import('@database');
        await insertLlmCallParts(1, [priced], db);

        const page = await getUsageCallPage(WIDE_RANGE, 0, 20);
        expect(page.rows[0]?.priced).toBe(true);
        expect(page.rows[0]?.costMicros).toBe(50);

        const persisted = JSON.parse(
            (
                database
                    .prepare("SELECT data FROM message_parts WHERE type = 'llm_call'")
                    .get() as { data: string }
            ).data
        ) as Record<string, unknown>;
        expect(persisted.pricingModel).toBe('deepseek-v4-flash');
        expect(persisted.currency).toBe('USD');
    });

    it('survives a wasted first attempt: both attempts keep their own usage', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const { db } = await import('@database');

        // 第一次尝试：请求失败，只有少量输入
        await insertLlmCallParts(1, [call({ errorMessage: 'timeout' })], db);
        await updateSessionTurnAttemptUsage({
            id: 1,
            usagePatch: {
                input_tokens: 191,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                reasoning_tokens: 0,
                total_cost_micros: 0,
                unpriced_calls: 1,
                ttft_ms: null,
                llm_call_count: 1,
            },
            database: db,
        });

        // 第二次尝试
        database.exec(`
            INSERT INTO session_turn_attempts (id, turn_id, attempt_index, checkpoint_json, delivery_manifest_json, status)
            VALUES (2, 1, 2, '{}', '{}', 'streaming');
        `);
        database.exec(`INSERT INTO messages (id, session_id, role) VALUES (2, 1, 'assistant');`);

        await insertLlmCallParts(2, [call({ iteration: 0 })], db);
        await updateSessionTurnAttemptUsage({
            id: 2,
            usagePatch: {
                input_tokens: 200,
                output_tokens: 30,
                cache_read_tokens: 100,
                cache_write_tokens: 0,
                reasoning_tokens: 5,
                total_cost_micros: 0,
                unpriced_calls: 1,
                ttft_ms: 900,
                llm_call_count: 1,
            },
            database: db,
        });

        // 回合级汇总必须是两个 attempt 之和
        await updateSessionTurnUsage({
            id: 1,
            usagePatch: {
                input_tokens: 391,
                output_tokens: 30,
                cache_read_tokens: 100,
                cache_write_tokens: 0,
                reasoning_tokens: 5,
                total_cost_micros: 0,
                unpriced_calls: 2,
                llm_call_count: 2,
                ttft_ms: 900,
            },
            database: db,
        });

        const summary = await getUsageSummary(WIDE_RANGE);
        expect(summary.inputTokens).toBe(391);
        expect(summary.requestCount).toBe(1);
        expect(summary.unpricedCount).toBe(2);

        const calls = database
            .prepare("SELECT count(*) AS n FROM message_parts WHERE type = 'llm_call'")
            .get() as { n: number };
        expect(calls.n).toBe(2);
    });
});
