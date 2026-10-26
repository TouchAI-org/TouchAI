import { getUsageByModel, getUsageSummary, getUsageTrend } from '@database/queries/usageStats';
import { afterEach, describe, expect, it } from 'vitest';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

/**
 * Every filter on the usage page narrows the same set of turns. A filter that silently does
 * nothing shows the user totals for conversations they excluded; one that over-filters hides
 * usage they paid for.
 */
afterEach(() => {
    closeTestDatabases();
});

const WIDE = { from: '1970-01-01 00:00:00', to: '9999-12-31 23:59:59' };

function seed(database: ReturnType<typeof openMigratedDatabase>) {
    database.exec(`
        INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'OpenAI', 'openai', 'https://example.com', 'openai'),
               (2, 'Anthropic', 'anthropic', 'https://example.com', 'anthropic');
        INSERT INTO models (id, provider_id, name, model_id)
        VALUES (1, 1, 'GPT-5', 'gpt-5'),
               (2, 2, 'Claude', 'claude');
        INSERT INTO sessions (id, session_id, title, model)
        VALUES (1, 's1', 'Deploy plan', 'gpt-5');
    `);
}

function turn(
    database: ReturnType<typeof openMigratedDatabase>,
    row: {
        id: number;
        modelId: number;
        status?: string;
        inputTokens?: number;
        error?: string | null;
        createdAt?: string;
    }
) {
    database
        .prepare(
            `INSERT INTO session_turns (
                id, session_id, model_id, task_id, prompt_snapshot_json, status,
                input_tokens, output_tokens, total_cost_micros, error_message, created_at
            ) VALUES (?, 1, ?, ?, '{}', ?, ?, 0, 0, ?, ?)`
        )
        .run(
            row.id,
            row.modelId,
            `task-${row.id}`,
            row.status ?? 'completed',
            row.inputTokens ?? 100,
            row.error ?? null,
            row.createdAt ?? '2026-05-01 10:00:00'
        );
}

describe('user narrows the usage page by model', () => {
    it('user gets only the chosen model counted', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 2, inputTokens: 900 });

        const summary = await getUsageSummary({ ...WIDE, modelIds: [1] });

        // The excluded model's tokens must not inflate the total.
        expect(summary.inputTokens).toBe(100);
    });

    it('user gets both models when both are chosen', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 2, inputTokens: 900 });

        const summary = await getUsageSummary({ ...WIDE, modelIds: [1, 2] });

        expect(summary.inputTokens).toBe(1_000);
    });
});

describe('user narrows the usage page by provider', () => {
    it('user gets only the turns of the chosen provider', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 2, inputTokens: 900 });

        const summary = await getUsageSummary({ ...WIDE, providerIds: [2] });

        // The provider filter resolves through the model table, not a stored column.
        expect(summary.inputTokens).toBe(900);
    });
});

describe('user narrows the usage page by status', () => {
    it('user gets only the failed turns when failures are chosen', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, status: 'completed', inputTokens: 100 });
        turn(database, { id: 2, modelId: 1, status: 'failed', inputTokens: 900 });

        const summary = await getUsageSummary({ ...WIDE, statuses: ['failed'] });

        expect(summary.inputTokens).toBe(900);
    });

    it('user gets only the failures when the failure-only switch is on', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, status: 'completed', inputTokens: 100 });
        turn(database, { id: 2, modelId: 1, status: 'failed', inputTokens: 900 });

        const summary = await getUsageSummary({ ...WIDE, onlyFailed: true });

        expect(summary.inputTokens).toBe(900);
    });

    it('user gets only the retried turns when the retry switch is on', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 1, inputTokens: 900 });
        // Only the second turn was retried, so only it has two attempts.
        database.exec(`
            INSERT INTO session_turn_attempts
                (turn_id, attempt_index, status, checkpoint_json, delivery_manifest_json, created_at)
            VALUES (2, 1, 'failed', '{}', '{}', '2026-05-01 10:00:00'),
                   (2, 2, 'completed', '{}', '{}', '2026-05-01 10:01:00');
        `);

        const summary = await getUsageSummary({ ...WIDE, onlyRetried: true });

        expect(summary.inputTokens).toBe(900);
    });
});

describe('user searches the usage page', () => {
    it('user gets the turn found by its error message', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, {
            id: 2,
            modelId: 1,
            inputTokens: 900,
            error: 'context length exceeded',
        });

        const summary = await getUsageSummary({ ...WIDE, search: 'context length' });

        expect(summary.inputTokens).toBe(900);
    });

    it('user gets the turn found by its model name', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 2, inputTokens: 900 });

        const summary = await getUsageSummary({ ...WIDE, search: 'Claude' });

        expect(summary.inputTokens).toBe(900);
    });

    it('user gets the turn found by its provider name', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 2, inputTokens: 900 });

        const summary = await getUsageSummary({ ...WIDE, search: 'Anthropic' });

        expect(summary.inputTokens).toBe(900);
    });

    it('user gets every turn for a search that is only spaces', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 2, inputTokens: 900 });

        const summary = await getUsageSummary({ ...WIDE, search: '   ' });

        // A blank search box is not a filter.
        expect(summary.inputTokens).toBe(1_000);
    });
});

describe('user combines several filters', () => {
    it('user gets only the turns that match every filter at once', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, status: 'completed', inputTokens: 100 });
        turn(database, { id: 2, modelId: 1, status: 'failed', inputTokens: 200 });
        turn(database, { id: 3, modelId: 2, status: 'failed', inputTokens: 900 });

        const summary = await getUsageSummary({
            ...WIDE,
            modelIds: [1],
            statuses: ['failed'],
        });

        // Filters intersect; they must not add up.
        expect(summary.inputTokens).toBe(200);
    });

    it('user gets the same filtered set in the model breakdown', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 2, inputTokens: 900 });

        const groups = await getUsageByModel({ ...WIDE, modelIds: [2] });

        expect(groups).toHaveLength(1);
        expect(groups[0]!.inputTokens).toBe(900);
    });

    it('user gets the same filtered set in the trend chart', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });
        turn(database, { id: 2, modelId: 2, inputTokens: 900 });

        const trend = await getUsageTrend({ ...WIDE, modelIds: [2] });

        const tokens = trend.points.reduce((sum, point) => sum + point.tokens, 0);
        expect(tokens).toBe(900);
    });

    it('user gets no rows when the filters exclude everything', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seed(database);
        turn(database, { id: 1, modelId: 1, inputTokens: 100 });

        const summary = await getUsageSummary({ ...WIDE, search: 'nothing-matches-this' });

        expect(summary.requestCount).toBe(0);
    });
});
