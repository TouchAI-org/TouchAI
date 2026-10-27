import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const root = 'src/database/drizzle';
const journal = JSON.parse(readFileSync(`${root}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string }[];
};

function applyMigrations(db: InstanceType<typeof DatabaseSync>) {
    for (const entry of journal.entries) {
        db.exec('BEGIN');
        try {
            for (const statement of migrationStatements(entry.tag)) db.exec(statement);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
}

function migrationStatements(tag: string) {
    return readFileSync(`${root}/${tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean);
}

function migrated() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrations(db);
    return db;
}

/** 建一条最小的 provider / model / session / turn / attempt 链路 */
function seed(db: InstanceType<typeof DatabaseSync>): void {
    db.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Test Provider', 'openai', 'https://example.com', 'openai');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES (1, 1, 'Test Model', 'test-model');
        INSERT INTO sessions (id, session_id, title, model)
        VALUES (1, 'session-1', 'Test Session', 'test-model');
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant');
        INSERT INTO session_turns (id, session_id, model_id, task_id, prompt_snapshot_json)
        VALUES (1, 1, 1, 'task-1', '{}');
        INSERT INTO session_turn_attempts (id, turn_id, attempt_index, checkpoint_json, delivery_manifest_json)
        VALUES (1, 1, 1, '{}', '{}');
    `);
}

/** 写入一条 llm_call 片段（模拟 UsageService 的落库载荷） */
function insertLlmCall(
    db: InstanceType<typeof DatabaseSync>,
    id: number,
    part: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costMicros: number;
        priced: boolean;
        ttftMs: number | null;
        sortOrder: number;
    }
): void {
    const data = JSON.stringify({
        iteration: 0,
        modelId: 1,
        modelName: 'test-model',
        providerId: 1,
        providerName: 'Test Provider',
        servedModel: null,
        usage: {
            inputTokens: part.inputTokens,
            outputTokens: part.outputTokens,
            cacheReadTokens: part.cacheReadTokens,
            cacheWriteTokens: part.cacheWriteTokens,
            reasoningTokens: 0,
        },
        timing: { ttftMs: part.ttftMs, durationMs: 1000 },
        finishReason: 'stop',
        errorMessage: null,
        toolCallsInStep: 0,
        toolArgumentErrors: 0,
        costMicros: part.costMicros,
        priced: part.priced,
        pricingModel: part.priced ? 'test-model' : null,
        currency: 'USD',
    });
    db.prepare(
        `INSERT INTO message_parts (id, message_id, type, content, data, sort_order, started_at, ended_at)
         VALUES (?, 1, 'llm_call', '', ?, ?, 1000, 2000)`
    ).run(id, data, part.sortOrder);
}

/** attempt 级聚合：与 PersistenceProjector.persistUsage 写入的列一致 */
function setAttemptTotals(
    db: InstanceType<typeof DatabaseSync>,
    attemptId: number,
    values: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        reasoning: number;
        cost: number;
        unpriced: number;
        ttft: number | null;
        calls: number;
    }
): void {
    db.prepare(
        `UPDATE session_turn_attempts SET
            input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
            reasoning_tokens = ?, total_cost_micros = ?, unpriced_calls = ?, ttft_ms = ?, llm_call_count = ?
         WHERE id = ?`
    ).run(
        values.input,
        values.output,
        values.cacheRead,
        values.cacheWrite,
        values.reasoning,
        values.cost,
        values.unpriced,
        values.ttft,
        values.calls,
        attemptId
    );
}

/** turn 级聚合：与 buildTurnUsageSumPatch 生成的 SQL 子查询一致 */
function refreshTurnTotals(db: InstanceType<typeof DatabaseSync>, turnId: number): void {
    db.prepare(
        `UPDATE session_turns SET
            input_tokens = (SELECT coalesce(sum(input_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
            output_tokens = (SELECT coalesce(sum(output_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
            cache_read_tokens = (SELECT coalesce(sum(cache_read_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
            cache_write_tokens = (SELECT coalesce(sum(cache_write_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
            reasoning_tokens = (SELECT coalesce(sum(reasoning_tokens), 0) FROM session_turn_attempts WHERE turn_id = ?),
            total_cost_micros = (SELECT coalesce(sum(total_cost_micros), 0) FROM session_turn_attempts WHERE turn_id = ?),
            unpriced_calls = (SELECT coalesce(sum(unpriced_calls), 0) FROM session_turn_attempts WHERE turn_id = ?),
            llm_call_count = (SELECT coalesce(sum(llm_call_count), 0) FROM session_turn_attempts WHERE turn_id = ?),
            ttft_ms = (SELECT ttft_ms FROM session_turn_attempts
                       WHERE turn_id = ? AND ttft_ms IS NOT NULL
                       ORDER BY attempt_index LIMIT 1)
         WHERE id = ?`
    ).run(turnId, turnId, turnId, turnId, turnId, turnId, turnId, turnId, turnId, turnId);
}

describe('when the app upgrades an existing database', () => {
    it('user gets an upgraded database without errors', () => {
        const db = migrated();
        try {
            const applied = db.prepare('SELECT count(*) AS count FROM sqlite_master').get() as {
                count: number;
            };
            expect(applied.count).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });

    it('user gets usage columns on the turn table', () => {
        const db = migrated();
        try {
            const columns = (
                db.prepare('PRAGMA table_info(session_turns)').all() as { name: string }[]
            ).map((column) => column.name);

            for (const name of [
                'input_tokens',
                'output_tokens',
                'cache_read_tokens',
                'cache_write_tokens',
                'reasoning_tokens',
                'total_cost_micros',
                'unpriced_calls',
                'ttft_ms',
                'first_text_ms',
                'llm_call_count',
                'tool_call_count',
                'model_switch_count',
                'tool_argument_error_count',
                'empty_response_count',
                'hit_iteration_ceiling',
                'error_code',
                'retry_scope',
                'prompt_breakdown_json',
            ]) {
                expect(columns).toContain(name);
            }
        } finally {
            db.close();
        }
    });

    it('user gets usage columns on the attempt table', () => {
        const db = migrated();
        try {
            const columns = (
                db.prepare('PRAGMA table_info(session_turn_attempts)').all() as { name: string }[]
            ).map((column) => column.name);

            for (const name of [
                'input_tokens',
                'output_tokens',
                'cache_read_tokens',
                'cache_write_tokens',
                'reasoning_tokens',
                'total_cost_micros',
                'unpriced_calls',
                'ttft_ms',
                'llm_call_count',
            ]) {
                expect(columns).toContain(name);
            }
        } finally {
            db.close();
        }
    });

    it('user gets pricing columns on the call metadata', () => {
        const db = migrated();
        try {
            const columns = (
                db.prepare('PRAGMA table_info(llm_metadata)').all() as { name: string }[]
            ).map((column) => column.name);

            for (const name of [
                'input_cost_per_million',
                'output_cost_per_million',
                'cache_read_cost_per_million',
                'cache_write_cost_per_million',
                'cost_currency',
            ]) {
                expect(columns).toContain(name);
            }
        } finally {
            db.close();
        }
    });

    it('user gets a daily rollup table keyed by day and model', () => {
        const db = migrated();
        try {
            const columns = (
                db.prepare('PRAGMA table_info(usage_daily_rollups)').all() as {
                    name: string;
                    pk: number;
                }[]
            ).filter((column) => column.pk > 0);

            expect(columns.map((column) => column.name).sort()).toEqual([
                'day',
                'model_name',
                'provider_name',
            ]);
        } finally {
            db.close();
        }
    });

    /**
     * The usage ledger landed while 0004 was still unreleased, so it lives in
     * that migration rather than in a separate one. A released migration must
     * never be edited, so this guards against the merging going further than
     * the last unreleased step.
     */
    it('user gets the usage ledger added by the latest migration only', () => {
        expect(journal.entries.map((entry) => entry.tag)).toEqual([
            '0000_lyrical_toad',
            '0001_silent_reasoning',
            '0002_quick_search_click_stats_unique',
            '0003_tough_amazoness',
            '0004_ordinary_solo',
            // 性能分支新增的只读投影与索引迁移。
            '0005_mighty_zombie',
            '0006_narrow_search_update_trigger',
            '0007_big_scarlet_spider',
            '0008_tool_part_projections',
        ]);
    });

    it('user gets model calls stored as their own part type', () => {
        const db = migrated();
        try {
            seed(db);
            insertLlmCall(db, 1, {
                inputTokens: 1000,
                outputTokens: 200,
                cacheReadTokens: 400,
                cacheWriteTokens: 0,
                costMicros: 12_000,
                priced: true,
                ttftMs: 850,
                sortOrder: 10,
            });

            const row = db
                .prepare(
                    `SELECT json_extract(data, '$.costMicros') AS cost,
                            json_extract(data, '$.timing.ttftMs') AS ttft
                     FROM message_parts WHERE type = 'llm_call'`
                )
                .get() as { cost: number; ttft: number };

            expect(row.cost).toBe(12_000);
            expect(row.ttft).toBe(850);

            // 表达式索引存在，且查询计划能用到它
            const indexes = (
                db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
                    name: string;
                }[]
            ).map((index) => index.name);
            expect(indexes).toContain('message_parts_llm_cost_idx');
            expect(indexes).toContain('message_parts_llm_ttft_idx');
        } finally {
            db.close();
        }
    });

    it('user sees turn totals matching the sum of their attempts', () => {
        const db = migrated();
        try {
            seed(db);
            // 第二个 attempt：模拟一次失败重试
            db.exec(`
                INSERT INTO session_turn_attempts (id, turn_id, attempt_index, checkpoint_json, delivery_manifest_json)
                VALUES (2, 1, 2, '{}', '{}');
            `);

            setAttemptTotals(db, 1, {
                input: 1000,
                output: 200,
                cacheRead: 400,
                cacheWrite: 100,
                reasoning: 50,
                cost: 12_000,
                unpriced: 0,
                ttft: null,
                calls: 2,
            });
            setAttemptTotals(db, 2, {
                input: 1500,
                output: 300,
                cacheRead: 600,
                cacheWrite: 150,
                reasoning: 80,
                cost: 18_000,
                unpriced: 1,
                ttft: 900,
                calls: 3,
            });

            refreshTurnTotals(db, 1);

            const turn = db
                .prepare(
                    `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                            reasoning_tokens, total_cost_micros, unpriced_calls, llm_call_count, ttft_ms
                     FROM session_turns WHERE id = 1`
                )
                .get() as Record<string, number | null>;

            expect(turn.input_tokens).toBe(2500);
            expect(turn.output_tokens).toBe(500);
            expect(turn.cache_read_tokens).toBe(1000);
            expect(turn.cache_write_tokens).toBe(250);
            expect(turn.reasoning_tokens).toBe(130);
            expect(turn.total_cost_micros).toBe(30_000);
            expect(turn.unpriced_calls).toBe(1);
            expect(turn.llm_call_count).toBe(5);
            // 首字取第一个有值的 attempt
            expect(turn.ttft_ms).toBe(900);
        } finally {
            db.close();
        }
    });

    it('user never sees model call payloads leak into the message text', () => {
        const db = migrated();
        try {
            seed(db);
            db.exec(`
                INSERT INTO message_parts (message_id, type, content, data, sort_order)
                VALUES (1, 'text', 'visible answer', '{}', 0);
            `);
            insertLlmCall(db, 2, {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costMicros: 1,
                priced: true,
                ttftMs: 100,
                sortOrder: 1,
            });

            // messageText 只读 text 与 tool_call；llm_call 的 content 为空，
            // 即使被读到也不会污染正文。
            const text = db
                .prepare(
                    `SELECT group_concat(content, '') AS text FROM (
                        SELECT CASE WHEN type = 'text' THEN content
                                    ELSE coalesce(json_extract(data, '$.output'), '') END AS content
                        FROM message_parts WHERE message_id = 1 AND type IN ('text', 'tool_call')
                        ORDER BY sort_order, id
                    )`
                )
                .get() as { text: string };

            expect(text.text).toBe('visible answer');
        } finally {
            db.close();
        }
    });
});
