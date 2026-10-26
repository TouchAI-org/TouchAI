// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    getSessionRanking,
    getToolUsageStats,
    getUsageByModel,
    getUsageComposition,
    getUsageDashboardSnapshot,
    getUsageTrend,
} from '@database/queries/usageStats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

/**
 * The usage page has three separate audiences: the latency figures at the top, the ranking lists
 * beside them, and the composition ring below. Each reads a different aggregate, so each has to
 * keep working when the data behind it is thinner than the schema allows.
 *
 * The Tauri SQL IPC is the boundary replaced here; the queries and the aggregation above it run
 * against the real migrated schema.
 */

afterEach(() => {
    closeTestDatabases();
    vi.useRealTimers();
});

const WIDE = { from: '1970-01-01 00:00:00', to: '9999-12-31 23:59:59' };

function seed(database: ReturnType<typeof openMigratedDatabase>) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, '[OI]', 'openai', 'https://example.com', 'openai'),
               (2, 'Anthropic', 'anthropic', 'https://example.com', 'anthropic');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES (1, 1, 'GPT-5', 'gpt-5'),
               (2, 2, 'Claude', 'claude');
        INSERT INTO sessions (id, session_id, title, model)
        VALUES (1, 's1', 'Deploy plan', 'gpt-5');
    `);
}

interface TurnSeed {
    id: number;
    modelId: number;
    createdAt: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costMicros?: number;
    durationMs?: number | null;
    ttftMs?: number | null;
    firstTextMs?: number | null;
    status?: string;
    taskId?: string;
    breakdown?: Record<string, unknown>;
}

function seedTurn(database: ReturnType<typeof openMigratedDatabase>, turn: TurnSeed) {
    database
        .prepare(
            `INSERT INTO session_turns (
                id, session_id, model_id, task_id, prompt_snapshot_json, prompt_breakdown_json,
                status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                total_cost_micros, duration_ms, ttft_ms, first_text_ms, created_at
            ) VALUES (?, 1, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            turn.id,
            turn.modelId,
            turn.taskId ?? `task-${turn.id}`,
            turn.breakdown ? JSON.stringify(turn.breakdown) : null,
            turn.status ?? 'completed',
            turn.inputTokens ?? 0,
            turn.outputTokens ?? 0,
            turn.cacheReadTokens ?? 0,
            turn.cacheWriteTokens ?? 0,
            turn.costMicros ?? 0,
            turn.durationMs ?? null,
            turn.ttftMs ?? null,
            turn.firstTextMs ?? null,
            turn.createdAt
        );
}

function seedToolPart(
    database: ReturnType<typeof openMigratedDatabase>,
    part: { id: number; data: Record<string, unknown>; createdAt: string; type?: string }
) {
    database
        .prepare(`INSERT OR IGNORE INTO messages (id, session_id, role) VALUES (1, 1, 'assistant')`)
        .run();
    database
        .prepare(
            `INSERT INTO message_parts (id, message_id, type, content, data, sort_order, created_at)
             VALUES (?, 1, ?, '', ?, ?, ?)`
        )
        .run(part.id, part.type ?? 'tool_call', JSON.stringify(part.data), part.id, part.createdAt);
}

describe('user reads the latency figures at the top of the usage page', () => {
    it('user sees the first-text average once a turn reported it', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
            outputTokens: 50,
            durationMs: 1_000,
            ttftMs: 200,
            firstTextMs: 800,
        });
        seedTurn(database, {
            id: 2,
            modelId: 1,
            createdAt: '2026-05-01 09:20:00',
            inputTokens: 100,
            outputTokens: 50,
            durationMs: 3_000,
            ttftMs: 400,
            firstTextMs: 1_200,
        });

        const { summary } = await getUsageDashboardSnapshot(WIDE, []);

        // 200 and 400 average to 300; 800 and 1200 average to 1000.
        expect(summary.meanTtftMs).toBe(300);
        expect(summary.meanFirstTextMs).toBe(1_000);
        expect(summary.meanDurationMs).toBe(2_000);
    });

    it('user sees a decode speed only when a duration was recorded', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            outputTokens: 100,
            durationMs: 2_000,
        });

        const { summary } = await getUsageDashboardSnapshot(WIDE, []);

        // 100 output tokens over one 2s request is 50 tok/s.
        expect(summary.decodeSpeed).toBeCloseTo(50);
    });

    it('user gets no decode speed when no duration was recorded', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            outputTokens: 100,
        });

        const { summary } = await getUsageDashboardSnapshot(WIDE, []);

        expect(summary.decodeSpeed).toBeNull();
    });

    it('user gets a zero success rate when nothing matched the filter', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);

        const { summary } = await getUsageDashboardSnapshot(WIDE, []);

        expect(summary.requestCount).toBe(0);
        expect(summary.successRate).toBe(0);
        expect(summary.cacheHitRate).toBe(0);
        expect(summary.firstRequestAt).toBeNull();
    });
});

describe('user ranks their sessions by the metric they picked', () => {
    it('user sees sessions ordered by active time when they pick duration', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model)
            VALUES (2, 's2', 'Quick question', 'claude');
        `);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 900,
            durationMs: 1_000,
        });
        seedTurn(database, {
            id: 2,
            modelId: 2,
            createdAt: '2026-05-01 09:20:00',
            inputTokens: 10,
            durationMs: 60_000,
        });
        database.exec(`UPDATE session_turns SET session_id = 2 WHERE id = 2`);

        const byDuration = await getSessionRanking(WIDE, 'duration');

        // The short-but-long-running session outranks the token-heavy one.
        expect(byDuration.map((row) => row.name)).toEqual(['Quick question', 'Deploy plan']);
        expect(byDuration[0]?.durationMs).toBe(60_000);
    });

    it('user sees sessions ordered by cost when they pick cost', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
            costMicros: 5,
        });

        const byCost = await getSessionRanking(WIDE, 'cost');

        expect(byCost[0]?.costMicros).toBe(5);
    });

    it('user sees sessions ordered by tokens by default', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
            outputTokens: 50,
        });

        const ranked = await getSessionRanking(WIDE);

        expect(ranked[0]?.tokens).toBe(150);
    });

    it('user gets a placeholder title and no subtitle for an unnamed session', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        database.exec(`UPDATE sessions SET title = '' WHERE id = 1`);
        database.exec(`UPDATE models SET name = '' WHERE id = 1`);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
        });

        const ranked = await getSessionRanking(WIDE);

        // A blank title would render as an empty row the user cannot identify.
        expect(ranked[0]?.name).toBe('—');
        expect(ranked[0]?.subtitle).toBeNull();
    });

    it('user gets the session subtitle showing which model it ran', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
        });

        expect((await getSessionRanking(WIDE))[0]?.subtitle).toBe('GPT-5');
    });
});

describe('user reads the composition ring', () => {
    it('user gets a zero cache share when no turn reported any input', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            outputTokens: 10,
            durationMs: 1_000,
        });

        const composition = await getUsageComposition(WIDE);

        expect(composition.cacheReadShare).toBe(0);
    });

    it('user gets a cache share above zero once input and cache reads are reported', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 1_000,
            cacheReadTokens: 3_000,
        });

        const composition = await getUsageComposition(WIDE);

        // 3000 cache reads out of 4000 billed input.
        expect(composition.cacheReadShare).toBeCloseTo(0.75);
    });

    it('user gets the prompt composition broken into the segments they can act on', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            outputTokens: 10,
            breakdown: {
                fragments: { platform: 400, policy: 200 },
                builtinToolDefinitions: 800,
                mcpToolDefinitions: 400,
                userPrompt: 300,
                attachments: 100,
                systemPromptTotal: 1_200,
            },
        });

        const composition = await getUsageComposition(WIDE);
        const keys = composition.tokens.segments.map((segment) => segment.key);

        expect(keys).toContain('systemPrompt');
        expect(keys).toContain('toolDefinitions');
        expect(keys).toContain('userPrompt');
        expect(keys).toContain('injections');
        expect(keys).toContain('output');
        expect(composition.tokens.total).toBeGreaterThan(0);
    });

    it('user gets an empty composition instead of an error when nothing ran', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);

        const composition = await getUsageComposition(WIDE);

        expect(composition.tokens.total).toBe(0);
        expect(composition.tokens.segments).toEqual([]);
        expect(composition.timing.segments).toEqual([]);
        expect(composition.timing.totalMs).toBe(0);
    });
});

describe('user reads the tool call report', () => {
    it('user gets a placeholder name for a tool call whose kind was not recorded', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedToolPart(database, {
            id: 1,
            createdAt: '2026-05-01 09:10:00',
            data: { status: 'success', duration_ms: 100 },
        });

        const stats = await getToolUsageStats(WIDE);

        // Without a kind the name cannot be rebuilt; the row still has to be counted.
        expect(stats.totalCount).toBe(1);
        expect(stats.byTool[0]?.name).toBe('—');
        expect(stats.byTool[0]?.kind).toBe('builtin');
    });

    it('user gets an MCP tool with no server name still labelled from what was recorded', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedToolPart(database, {
            id: 1,
            createdAt: '2026-05-01 09:10:00',
            data: { toolKind: 'mcp', tool_name: 'read', status: 'success' },
        });

        const stats = await getToolUsageStats(WIDE);

        expect(stats.byTool[0]?.name).toBe('mcp____read');
        expect(stats.byTool[0]?.kind).toBe('mcp');
    });

    it('user does not get non-tool parts counted as tool calls', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedToolPart(database, {
            id: 1,
            createdAt: '2026-05-01 09:10:00',
            type: 'text',
            data: { toolKind: 'builtin', tool_id: 'shell' },
        });

        const stats = await getToolUsageStats(WIDE);

        expect(stats.totalCount).toBe(0);
        expect(stats.byTool).toEqual([]);
    });
});

describe('user reads the per-model breakdown table', () => {
    it('user sees the first-token average per model once a turn reported it', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
            ttftMs: 250,
            durationMs: 1_000,
        });

        const byModel = await getUsageByModel(WIDE);

        expect(byModel[0]?.meanTtftMs).toBe(250);
        expect(byModel[0]?.meanDurationMs).toBe(1_000);
    });

    it('user gets no first-token average for a model that never reported one', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
        });

        const byModel = await getUsageByModel(WIDE);

        // A model with no timing samples must not claim it answered in zero milliseconds.
        expect(byModel[0]?.meanTtftMs).toBeNull();
        expect(byModel[0]?.meanDurationMs).toBeNull();
    });
});

describe('user reads the trend split by provider', () => {
    it('user gets a provider segment named after the provider that served the turn', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 2,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
        });

        const trend = await getUsageTrend(
            { from: '2026-05-01 00:00:00', to: '2026-05-01 23:59:59' },
            'provider'
        );

        expect(trend.points[0]?.segments).toEqual([
            expect.objectContaining({ name: 'Anthropic', groupId: 2 }),
        ]);
    });

    it('user gets a placeholder provider name when the provider has none', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        database.exec(`UPDATE providers SET name = '' WHERE id = 1`);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
        });

        const trend = await getUsageTrend(
            { from: '2026-05-01 00:00:00', to: '2026-05-01 23:59:59' },
            'provider'
        );

        expect(trend.points[0]?.segments[0]?.name).toBe('—');
    });
});
