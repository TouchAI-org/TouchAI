import {
    getToolUsageStats,
    getUsageByModel,
    getUsageByProvider,
    getUsageDashboardSnapshot,
    getUsageFilterOptions,
    getUsageHeatmap,
    getUsageTrend,
} from '@database/queries/usageStats';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

afterEach(() => {
    closeTestDatabases();
    vi.useRealTimers();
});

const WIDE = { from: '1970-01-01 00:00:00', to: '9999-12-31 23:59:59' };

function seed(database: ReturnType<typeof openMigratedDatabase>) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'OpenAI', 'openai', 'https://example.com', 'openai'),
               (2, 'Anthropic', 'anthropic', 'https://example.com', 'anthropic');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES (1, 1, 'GPT-5', 'gpt-5'),
               (2, 1, 'GPT-5 Mini', 'gpt-5-mini'),
               (3, 2, 'Claude', 'claude');
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
    status?: string;
    taskId?: string;
}

function seedTurn(database: ReturnType<typeof openMigratedDatabase>, turn: TurnSeed) {
    database
        .prepare(
            `INSERT INTO session_turns (
                id, session_id, model_id, task_id, prompt_snapshot_json, status,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                total_cost_micros, duration_ms, created_at
            ) VALUES (?, 1, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            turn.id,
            turn.modelId,
            turn.taskId ?? `task-${turn.id}`,
            turn.status ?? 'completed',
            turn.inputTokens ?? 0,
            turn.outputTokens ?? 0,
            turn.cacheReadTokens ?? 0,
            turn.cacheWriteTokens ?? 0,
            turn.costMicros ?? 0,
            turn.durationMs ?? null,
            turn.createdAt
        );
}

describe('when the user looks at the usage trend over a few days', () => {
    it('user sees one point per bucket with each model as its own stacked segment', async () => {
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
        seedTurn(database, {
            id: 2,
            modelId: 3,
            createdAt: '2026-05-01 09:40:00',
            inputTokens: 10,
            outputTokens: 5,
        });
        seedTurn(database, {
            id: 3,
            modelId: 1,
            createdAt: '2026-05-03 15:05:00',
            inputTokens: 7,
            outputTokens: 3,
        });

        const trend = await getUsageTrend({
            from: '2026-05-01 00:00:00',
            to: '2026-05-03 23:59:59',
        });

        expect(trend.bucket).toBe('hour');
        expect(trend.points).toHaveLength(2);

        // The first bucket holds two models; the bigger one comes first so the
        // chart can take the top N without re-sorting.
        expect(trend.points[0]?.requests).toBe(2);
        expect(trend.points[0]?.tokens).toBe(165);
        expect(trend.points[0]?.segments.map((segment) => segment.name)).toEqual([
            'GPT-5',
            'Claude',
        ]);
        expect(trend.points[0]?.segments[0]?.tokens).toBe(150);
    });

    it('user sees minute buckets so a range inside one hour still shows a shape', async () => {
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
        seedTurn(database, {
            id: 2,
            modelId: 1,
            createdAt: '2026-05-01 09:50:00',
            inputTokens: 10,
            outputTokens: 5,
        });

        const trend = await getUsageTrend({
            from: '2026-05-01 09:00:00',
            to: '2026-05-01 10:00:00',
        });

        expect(trend.bucket).toBe('minute');
        expect(trend.points).toHaveLength(2);
        expect(trend.points[0]?.key).toBe('2026-05-01 09:10');
        expect(trend.points[1]?.key).toBe('2026-05-01 09:50');
    });

    it('user gets the trend split by provider when the chart switches dimension', async () => {
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
        seedTurn(database, {
            id: 2,
            modelId: 2,
            createdAt: '2026-05-01 09:20:00',
            inputTokens: 40,
            outputTokens: 10,
        });

        const trend = await getUsageTrend(
            { from: '2026-05-01 00:00:00', to: '2026-05-01 23:59:59' },
            'provider'
        );

        // Both models belong to the same provider, so they fold into one segment.
        expect(trend.points[0]?.segments).toEqual([
            expect.objectContaining({ name: 'OpenAI', groupId: 1, tokens: 200 }),
        ]);
    });

    it('user gets day buckets once the range spans months', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-03-15 09:10:00',
            inputTokens: 10,
            outputTokens: 5,
        });

        const trend = await getUsageTrend({
            from: '2026-01-01 00:00:00',
            to: '2026-12-31 23:59:59',
        });

        expect(trend.bucket).toBe('day');
        expect(trend.points[0]?.key).toBe('2026-03-15');
    });

    it('user gets an empty trend instead of an error when nothing ran in the range', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);

        const trend = await getUsageTrend({
            from: '2026-01-01 00:00:00',
            to: '2026-01-02 00:00:00',
        });

        expect(trend.points).toEqual([]);
    });
});

describe('when the user opens the usage dashboard', () => {
    it('user gets the summary, the running turns and the trend from one snapshot', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
            outputTokens: 50,
            costMicros: 900,
            durationMs: 1000,
            taskId: 'task-live',
        });
        seedTurn(database, {
            id: 2,
            modelId: 1,
            createdAt: '2026-05-01 09:20:00',
            inputTokens: 10,
            outputTokens: 5,
            costMicros: 100,
            durationMs: 500,
            taskId: 'task-other',
        });

        const snapshot = await getUsageDashboardSnapshot(
            { from: '2026-05-01 00:00:00', to: '2026-05-01 23:59:59' },
            ['task-live']
        );

        expect(snapshot.summary.requestCount).toBe(2);
        expect(snapshot.summary.totalCostMicros).toBe(1000);
        // Only the requested task is reported back as a live baseline.
        expect(snapshot.liveTurns).toEqual([
            {
                taskId: 'task-live',
                createdAt: '2026-05-01 09:10:00',
                status: 'completed',
                outputTokens: 50,
                totalCostMicros: 900,
                durationMs: 1000,
            },
        ]);
        expect(snapshot.trend.points).toHaveLength(1);
    });

    it('user gets no live turns when the page has no running task to subtract', async () => {
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

        const snapshot = await getUsageDashboardSnapshot(
            { from: '2026-05-01 00:00:00', to: '2026-05-01 23:59:59' },
            []
        );

        expect(snapshot.liveTurns).toEqual([]);
        expect(snapshot.summary.requestCount).toBe(1);
    });
});

describe('when the user breaks the usage down by model or provider', () => {
    it('user sees one row per model, busiest first', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 500,
            outputTokens: 100,
            durationMs: 1000,
            status: 'completed',
        });
        seedTurn(database, {
            id: 2,
            modelId: 3,
            createdAt: '2026-05-01 09:20:00',
            inputTokens: 10,
            outputTokens: 5,
            durationMs: 2000,
            status: 'failed',
        });

        const byModel = await getUsageByModel(WIDE);

        expect(byModel.map((group) => group.name)).toEqual(['GPT-5', 'Claude']);
        expect(byModel[0]).toMatchObject({
            requestCount: 1,
            successCount: 1,
            inputTokens: 500,
            outputTokens: 100,
            meanDurationMs: 1000,
        });
        expect(byModel[1]).toMatchObject({ requestCount: 1, successCount: 0 });
    });

    it('user sees one row per provider', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 500,
            outputTokens: 100,
        });
        seedTurn(database, {
            id: 2,
            modelId: 3,
            createdAt: '2026-05-01 09:20:00',
            inputTokens: 10,
            outputTokens: 5,
        });

        const byProvider = await getUsageByProvider(WIDE);

        expect(byProvider.map((group) => group.name)).toEqual(['OpenAI', 'Anthropic']);
        expect(byProvider[0]?.inputTokens).toBe(500);
    });

    it('user gets an em dash instead of a blank label for a group without a name', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        database.exec(`UPDATE models SET name = '' WHERE id = 1`);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 1,
            outputTokens: 1,
        });

        const byModel = await getUsageByModel(WIDE);

        expect(byModel[0]?.name).toBe('—');
    });
});

describe('when the user opens the usage filter dropdowns', () => {
    it('user gets the models and providers that actually ran, most used first', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 1,
        });
        seedTurn(database, {
            id: 2,
            modelId: 1,
            createdAt: '2026-05-01 09:20:00',
            inputTokens: 1,
        });
        seedTurn(database, {
            id: 3,
            modelId: 3,
            createdAt: '2026-05-01 09:30:00',
            inputTokens: 1,
        });

        const options = await getUsageFilterOptions(WIDE);

        expect(options.models).toEqual([
            { id: 1, name: 'GPT-5', count: 2 },
            { id: 3, name: 'Claude', count: 1 },
        ]);
        expect(options.providers).toEqual([
            { id: 1, name: 'OpenAI', count: 2 },
            { id: 2, name: 'Anthropic', count: 1 },
        ]);
    });
});

describe('when the user looks at tool call statistics', () => {
    function seedToolPart(
        database: ReturnType<typeof openMigratedDatabase>,
        part: {
            id: number;
            data: Record<string, unknown>;
            createdAt: string;
            type?: string;
        }
    ) {
        database
            .prepare(
                `INSERT OR IGNORE INTO messages (id, session_id, role)
                 VALUES (1, 1, 'assistant')`
            )
            .run();
        database
            .prepare(
                `INSERT INTO message_parts (id, message_id, type, content, data, sort_order, created_at)
                 VALUES (?, 1, ?, '', ?, ?, ?)`
            )
            .run(
                part.id,
                part.type ?? 'tool_call',
                JSON.stringify(part.data),
                part.id,
                part.createdAt
            );
    }

    it('user sees builtin and MCP tools counted separately with their own names', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedToolPart(database, {
            id: 1,
            createdAt: '2026-05-01 09:10:00',
            data: { toolKind: 'builtin', tool_id: 'shell', status: 'success', duration_ms: 100 },
        });
        seedToolPart(database, {
            id: 2,
            createdAt: '2026-05-01 09:20:00',
            data: { toolKind: 'builtin', tool_id: 'shell', status: 'error', duration_ms: 300 },
        });
        seedToolPart(database, {
            id: 3,
            createdAt: '2026-05-01 09:30:00',
            data: {
                toolKind: 'mcp',
                server_id: 'files',
                tool_name: 'read',
                status: 'success',
                duration_ms: 50,
            },
        });

        const stats = await getToolUsageStats(WIDE);

        expect(stats.totalCount).toBe(3);
        expect(stats.errorCount).toBe(1);
        expect(stats.distinctTools).toBe(2);
        expect(stats.meanDurationMs).toBe(150);
        expect(stats.byTool).toEqual([
            {
                name: 'builtin__shell',
                kind: 'builtin',
                count: 2,
                errorCount: 1,
                meanDurationMs: 200,
            },
            { name: 'mcp__files__read', kind: 'mcp', count: 1, errorCount: 0, meanDurationMs: 50 },
        ]);
    });

    it('user sees timeouts and rejections counted as errors, not just plain failures', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedToolPart(database, {
            id: 1,
            createdAt: '2026-05-01 09:10:00',
            data: { toolKind: 'builtin', tool_id: 'shell', status: 'timeout' },
        });
        seedToolPart(database, {
            id: 2,
            createdAt: '2026-05-01 09:20:00',
            data: { toolKind: 'builtin', tool_id: 'shell', status: 'rejected' },
        });

        const stats = await getToolUsageStats(WIDE);

        expect(stats.errorCount).toBe(2);
        // No duration was recorded, so the mean stays unknown instead of becoming 0.
        expect(stats.meanDurationMs).toBeNull();
        expect(stats.byTool[0]?.meanDurationMs).toBeNull();
    });

    it('user gets an empty tool report when no tool ran in the range', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);

        const stats = await getToolUsageStats(WIDE);

        expect(stats).toEqual({
            totalCount: 0,
            errorCount: 0,
            distinctTools: 0,
            meanDurationMs: null,
            byTool: [],
        });
    });
});

describe('when the user looks at the activity heatmap', () => {
    it('user sees cells per day and hour so a single day still shows density', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2026-05-01 09:10:00',
            inputTokens: 100,
            outputTokens: 50,
            costMicros: 7,
        });
        seedTurn(database, {
            id: 2,
            modelId: 1,
            createdAt: '2026-05-01 09:40:00',
            inputTokens: 10,
            outputTokens: 5,
        });

        const heatmap = await getUsageHeatmap(WIDE);

        expect(heatmap).toHaveLength(1);
        expect(heatmap[0]).toMatchObject({ day: '2026-05-01', requests: 2, tokens: 165 });
    });

    it('user gets an empty heatmap instead of an error when nothing ran this year', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-10T12:00:00Z'));
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        // Older than a year: the heatmap always shows the last twelve months.
        seedTurn(database, {
            id: 1,
            modelId: 1,
            createdAt: '2020-05-01 09:10:00',
            inputTokens: 100,
        });

        const heatmap = await getUsageHeatmap(WIDE);

        expect(heatmap).toEqual([]);
    });
});
