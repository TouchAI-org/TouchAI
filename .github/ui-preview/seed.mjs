/**
 * Fills the recording's throwaway app root with made-up usage data.
 *
 * A fresh install has no requests, so the Usage page records as a row of
 * zeros and the model list is empty. This script writes fixture rows into the
 * SQLite file the app created on its first boot. It only inserts data: no
 * schema change, no migration, and nothing outside TOUCHAI_APP_ROOT.
 *
 * The same seed produces the same numbers on every run, so two recordings of
 * one pull request differ only by the pull request.
 */

import fs from 'node:fs';
import path from 'node:path';

const PROVIDER = 'Fixture Relay';
const SESSION_PREFIX = 'fixture-';
const DAYS = 30;

function fail(message) {
    console.error(`seed: ${message}`);
    process.exit(1);
}

const appRoot = String(process.env.TOUCHAI_APP_ROOT ?? '').trim();

if (!appRoot) {
    fail('TOUCHAI_APP_ROOT is not set');
}

const databasePath = path.join(appRoot, 'data', 'touchai.db');

if (!fs.existsSync(databasePath)) {
    fail(`${databasePath} does not exist; boot the app once before seeding`);
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(databasePath);

// A fixed sequence, so the same pull request records the same data twice.
let state = 20261026;
const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
};
const between = (low, high) => Math.round(low + random() * (high - low));
const pick = (values) => values[Math.floor(random() * values.length)];

const MODELS = [
    {
        name: 'fixture-large',
        modelId: 'fixture/large',
        reasoning: 1,
        context: 200000,
        output: 64000,
    },
    { name: 'fixture-mini', modelId: 'fixture/mini', reasoning: 0, context: 128000, output: 16000 },
];
const AGENTS = ['Codex', 'Claude Code', 'OpenCode'];
const TITLES = [
    'Refactor the search indexer',
    'Add a settings toggle for usage retention',
    'Fix the shortcut recorder on Linux',
    'Explain the window blur handling',
    'Draft the release notes',
    'Review the clipboard rules',
];
const PROMPTS = [
    'Summarise the diff in three bullets.',
    'Why does the search window hide on blur?',
    'Add a regression test for the settings toggle.',
    'Explain how the usage rollups are built.',
    'Rewrite this function without the early return.',
    'What changed in the window manager this week?',
];

function isoDaysAgo(days, hour, minute) {
    const date = new Date();
    // Local wall-clock hours, stored as UTC: the Usage page groups by
    // `date(created_at, 'localtime')`, so UTC hours would push the newest rows
    // past midnight and leave "Today" nearly empty.
    date.setDate(date.getDate() - days);
    date.setHours(hour, minute, between(0, 59), 0);
    return date.toISOString().replace('T', ' ').replace('Z', '');
}

function clearFixture() {
    const sessions = db
        .prepare('SELECT id FROM sessions WHERE session_id LIKE ?')
        .all(`${SESSION_PREFIX}%`)
        .map((row) => Number(row.id));

    for (const id of sessions) {
        db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(id);
    }

    db.prepare('DELETE FROM sessions WHERE session_id LIKE ?').run(`${SESSION_PREFIX}%`);

    const provider = db.prepare('SELECT id FROM providers WHERE name = ?').get(PROVIDER);

    if (provider) {
        db.prepare('DELETE FROM models WHERE provider_id = ?').run(provider.id);
        db.prepare('DELETE FROM providers WHERE id = ?').run(provider.id);
    }

    db.prepare('DELETE FROM usage_daily_rollups WHERE provider_name = ?').run(PROVIDER);
}

function insertProvider() {
    db.prepare(
        `INSERT INTO providers (name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(PROVIDER, 'openai-compatible', 'http://127.0.0.1:9/v1', null, null, 'openai.png', 1, 0);

    return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}

function insertModels(providerId) {
    const ids = [];

    for (const model of MODELS) {
        db.prepare(
            `INSERT INTO models
                (provider_id, name, model_id, is_default, attachment, modalities, reasoning,
                 tool_call, context_limit, output_limit, temperature)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            providerId,
            model.name,
            model.modelId,
            model === MODELS[0] ? 1 : 0,
            0,
            '["text"]',
            model.reasoning,
            1,
            model.context,
            model.output,
            1
        );
        ids.push(Number(db.prepare('SELECT last_insert_rowid() AS id').get().id));
    }

    return ids;
}

function insertSessions(providerId) {
    const ids = [];

    for (let index = 0; index < TITLES.length; index += 1) {
        const createdAt = isoDaysAgo(index * 4 + 1, 9 + index, 12);
        db.prepare(
            `INSERT INTO sessions
                (session_id, title, model, provider_id, last_message_preview, last_message_at,
                 message_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            `${SESSION_PREFIX}${index + 1}`,
            TITLES[index],
            pick(MODELS).modelId,
            providerId,
            PROMPTS[index % PROMPTS.length],
            createdAt,
            between(2, 18),
            createdAt,
            createdAt
        );
        ids.push(Number(db.prepare('SELECT last_insert_rowid() AS id').get().id));
    }

    return ids;
}

function insertTurns(sessionIds, modelIds) {
    let requests = 0;

    for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo -= 1) {
        // Today is the page's default range, so it gets enough rows to show a
        // real dashboard rather than a single bar.
        const perDay = daysAgo === 0 ? between(5, 9) : between(0, 6);

        for (let index = 0; index < perDay; index += 1) {
            const modelIndex = random() < 0.35 ? 1 : 0;
            const inputTokens = between(1200, 18000);
            const outputTokens = between(200, 2400);
            const cacheRead = between(0, inputTokens);
            const durationMs = between(1200, 24000);
            const ttftMs = between(180, Math.min(2400, durationMs));
            const costMicros = Math.round(inputTokens * 0.9 + outputTokens * 7.5);
            const status = random() < 0.04 ? 'failed' : 'completed';
            const createdAt = isoDaysAgo(daysAgo, between(8, 22), between(0, 59));

            db.prepare(
                `INSERT INTO session_turns
                    (session_id, model_id, task_id, execution_mode, prompt_snapshot_json, status,
                     error_message, tokens_used, duration_ms, created_at, updated_at,
                     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                     reasoning_tokens, total_cost_micros, unpriced_calls, ttft_ms,
                     first_text_ms, llm_call_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                sessionIds[requests % sessionIds.length],
                modelIds[modelIndex],
                `${SESSION_PREFIX}task-${requests}`,
                'foreground',
                JSON.stringify({ agent: pick(AGENTS), prompt: PROMPTS[requests % PROMPTS.length] }),
                status,
                status === 'failed' ? 'provider returned 429' : null,
                inputTokens + outputTokens,
                durationMs,
                createdAt,
                createdAt,
                inputTokens,
                outputTokens,
                cacheRead,
                0,
                modelIndex === 0 ? between(0, 800) : 0,
                costMicros,
                0,
                ttftMs,
                ttftMs + between(40, 400),
                between(1, 4)
            );
            requests += 1;
        }
    }

    return requests;
}

function insertRollups() {
    const rows = db
        .prepare(
            `SELECT date(t.created_at) AS day,
                    m.name AS model_name,
                    count(*) AS requests,
                    sum(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS successes,
                    sum(t.input_tokens) AS input_tokens,
                    sum(t.output_tokens) AS output_tokens,
                    sum(t.cache_read_tokens) AS cache_read_tokens,
                    sum(t.cache_write_tokens) AS cache_write_tokens,
                    sum(t.reasoning_tokens) AS reasoning_tokens,
                    sum(t.total_cost_micros) AS cost,
                    sum(t.unpriced_calls) AS unpriced,
                    sum(t.ttft_ms) AS ttft,
                    sum(t.duration_ms) AS duration,
                    count(t.ttft_ms) AS ttft_samples
             FROM session_turns t
             JOIN sessions s ON s.id = t.session_id
             JOIN models m ON m.id = t.model_id
             WHERE s.session_id LIKE ?
             GROUP BY day, m.name`
        )
        .all(`${SESSION_PREFIX}%`);

    const insert = db.prepare(
        `INSERT OR REPLACE INTO usage_daily_rollups
            (day, model_name, provider_name, request_count, success_count, input_tokens,
             output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
             total_cost_micros, unpriced_count, sum_ttft_ms, sum_duration_ms, ttft_sample_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const row of rows) {
        insert.run(
            row.day,
            row.model_name,
            PROVIDER,
            row.requests,
            row.successes,
            row.input_tokens,
            row.output_tokens,
            row.cache_read_tokens,
            row.cache_write_tokens,
            row.reasoning_tokens,
            row.cost,
            row.unpriced,
            row.ttft,
            row.duration,
            row.ttft_samples
        );
    }

    return rows.length;
}

try {
    db.exec('BEGIN');
    clearFixture();
    const providerId = insertProvider();
    const modelIds = insertModels(providerId);
    const sessionIds = insertSessions(providerId);
    const requests = insertTurns(sessionIds, modelIds);
    const days = insertRollups();
    db.exec('COMMIT');
    console.log(
        `seed: ${requests} turns over ${days} day/model rows, ${sessionIds.length} sessions, ${modelIds.length} models`
    );
} catch (error) {
    try {
        db.exec('ROLLBACK');
    } catch {
        // The transaction never started.
    }

    fail(error.stack ?? error.message);
} finally {
    db.close();
}
