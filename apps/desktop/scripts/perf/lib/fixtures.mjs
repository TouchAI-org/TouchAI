import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { verifyBuiltArms } from './build.mjs';
import { readComparison } from './comparison.mjs';
import {
    arms,
    artifactsRoot,
    baselineSnapshot,
    binaryPathByArm,
    currentSnapshot,
    evidenceRoot,
    fixtureLevels,
    fixturePathByArm,
    fixturesRoot,
    logsRoot,
    MANIFEST_VERSION,
    modelEndpoint,
    repoRoot,
} from './config.mjs';
import {
    ensureDirectory,
    nowIso,
    removeManagedDirectory,
    sha256File,
    sha256Text,
    writeJson,
} from './io.mjs';
import { runSync } from './process.mjs';

const volatileBusinessColumns = new Set([
    'created_at',
    'updated_at',
    'last_message_at',
    'last_used_at',
    'pinned_at',
    'archived_at',
]);

const businessTableNames = [
    'attachments',
    'attachment_remote_refs',
    'built_in_tools',
    'llm_metadata',
    'llm_metadata_aliases',
    'mcp_servers',
    'mcp_tools',
    'message_parts',
    'messages',
    'models',
    'providers',
    'quick_search_click_stats',
    'session_turn_attempts',
    'session_turns',
    'sessions',
    'settings',
    'statistics',
    'touchai_meta',
    'usage_daily_rollups',
];

async function initializeDatabaseFromArm(arm) {
    const snapshot = arm === 'baseline' ? baselineSnapshot : currentSnapshot;
    const initRoot = path.join(artifactsRoot, 'fixture-init-root', arm);
    removeManagedDirectory(initRoot, artifactsRoot);
    const initialized = path.join(initRoot, 'data/touchai.db');
    const { seedAgentDatabase } = await import(
        pathToFileURL(path.join(snapshot, 'apps/desktop/e2e-tests/test/support/agent-fixture.js'))
            .href
    );
    seedAgentDatabase(initialized, modelEndpoint);
    const migrationTags = runSync('sqlite3', [
        initialized,
        'SELECT hash FROM migrations ORDER BY id;',
    ])
        .stdout.trim()
        .split('\n')
        .filter(Boolean);
    return { initialized, initRoot, migrationTags };
}

function runSqlite(database, sql, log) {
    return runSync('sqlite3', [database], {
        input: sql,
        log,
        cwd: repoRoot,
    });
}

export function configureBaseFixture(database) {
    const sql = `
BEGIN IMMEDIATE;
DELETE FROM models;
UPDATE providers SET enabled = 0;
INSERT INTO providers (name, driver, api_endpoint, api_key, logo, enabled, is_builtin)
VALUES ('Performance fixture', 'openai-compatible', '${modelEndpoint}', 'perf-only', 'test', 1, 0);
UPDATE built_in_tools SET enabled = CASE WHEN tool_id = 'setting' THEN 1 ELSE 0 END;
INSERT INTO models (
    provider_id, name, model_id, is_default, last_used_at,
    attachment, modalities, open_weights, reasoning, reasoning_options,
    release_date, temperature, tool_call, knowledge, context_limit, output_limit,
    is_custom_metadata, upstream_metadata, created_at, updated_at
)
SELECT
    id, 'Perf model', 'perf-model', 1, datetime('now'),
    0, '{"input":["text"],"output":["text"]}', 0, 1, NULL,
    NULL, 1, 1, NULL, 131072, 16384,
    1, NULL, datetime('now'), datetime('now')
FROM providers
WHERE name = 'Performance fixture' AND driver = 'openai-compatible';
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
VACUUM;
`;
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const connection = new DatabaseSync(database);
    try {
        connection.exec(sql);
    } finally {
        connection.close();
    }
}

function createLongFixture(baseDatabase, level, destination) {
    fs.copyFileSync(baseDatabase, destination);
    const sessionKey = `perf-long-${level}`;
    const sql = `
BEGIN IMMEDIATE;
INSERT INTO sessions (
    session_id, title, model, provider_id, last_message_preview, last_message_at,
    message_count, created_at, updated_at
)
SELECT
    '${sessionKey}', 'Perf history ${level}', 'perf-model', id,
    'perf long-session fixture', datetime('now', '+1 minute'),
    ${level}, datetime('now'), datetime('now', '+1 minute')
FROM providers
WHERE name = 'Performance fixture' AND driver = 'openai-compatible';

WITH RECURSIVE seq(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < ${level}
)
INSERT INTO messages (session_id, role, created_at, updated_at)
SELECT
    sessions.id,
    CASE WHEN n % 2 = 1 THEN 'user' ELSE 'assistant' END,
    datetime('now', printf('-%d seconds', ${level} - n)),
    datetime('now', printf('-%d seconds', ${level} - n))
FROM sessions
CROSS JOIN seq
WHERE sessions.session_id = '${sessionKey}';

WITH RECURSIVE seq(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < ${level}
),
ranked AS (
    SELECT
        messages.id,
        row_number() OVER (ORDER BY messages.id) AS n
    FROM messages
    WHERE messages.session_id = (
        SELECT id FROM sessions WHERE session_id = '${sessionKey}'
    )
)
INSERT INTO message_parts (
    message_id, type, content, data, sort_order, created_at, updated_at
)
SELECT
    ranked.id,
    'text',
    printf('perf-long-%04d-', ranked.n) || replace(hex(zeroblob(10240)), '00', 'x'),
    '{}',
    0,
    datetime('now'),
    datetime('now')
FROM ranked
INNER JOIN seq ON seq.n = ranked.n;
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
VACUUM;
`;
    runSqlite(destination, sql, path.join(logsRoot, `fixture-long-${level}.log`));
}

function readTableInfo(database, table, log) {
    const escaped = table.replaceAll('"', '""');
    const output = runSync('sqlite3', ['-json', database, `PRAGMA table_info("${escaped}");`], {
        log,
    }).stdout.trim();
    const rows = output ? JSON.parse(output) : [];
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`Business table '${table}' is missing from ${database}`);
    }
    return rows;
}

function buildBusinessProjection(baselineDatabase, currentDatabase, log) {
    const projection = [];
    for (const table of businessTableNames) {
        const baselineInfo = readTableInfo(baselineDatabase, table, log);
        const currentInfo = readTableInfo(currentDatabase, table, log);
        const currentColumns = new Set(currentInfo.map((column) => column.name));
        const columns = baselineInfo
            .map((column) => column.name)
            .filter((column) => currentColumns.has(column) && !volatileBusinessColumns.has(column));
        const baselinePrimaryKey = baselineInfo
            .filter((column) => Number(column.pk) > 0)
            .sort((left, right) => Number(left.pk) - Number(right.pk))
            .map((column) => column.name);
        const currentPrimaryKey = currentInfo
            .filter((column) => Number(column.pk) > 0)
            .sort((left, right) => Number(left.pk) - Number(right.pk))
            .map((column) => column.name);
        if (baselinePrimaryKey.length === 0) {
            throw new Error(`Business table '${table}' has no primary key`);
        }
        if (baselinePrimaryKey.join('\0') !== currentPrimaryKey.join('\0')) {
            throw new Error(`Business table '${table}' has a different primary key by arm`);
        }
        if (columns.length === 0) {
            throw new Error(`Business table '${table}' has no comparable columns`);
        }
        projection.push({ table, columns, primaryKey: baselinePrimaryKey });
    }
    return projection;
}

function businessOracleSha256(database, projection, log) {
    const dumps = [];
    for (const { table, columns, primaryKey } of projection) {
        const escaped = table.replaceAll('"', '""');
        const selected = columns
            .map((column) => `quote("${column.replaceAll('"', '""')}")`)
            .join(', ');
        const orderBy = primaryKey.map((column) => `"${column.replaceAll('"', '""')}"`).join(', ');
        const query = `SELECT ${selected} FROM "${escaped}" ORDER BY ${orderBy};`;
        const dump = runSync('sqlite3', [database, query], { log }).stdout;
        dumps.push(`${table}\t${columns.join(',')}\n${dump}`);
    }
    return sha256Text(dumps.join('\n'));
}

export async function prepareFixtures() {
    verifyBuiltArms();
    ensureDirectory(fixturesRoot);
    // Fixtures and their manifest are one generation. Make the old manifest
    // unreadable before replacing any database so a partial regeneration cannot
    // be mistaken for the previous complete generation.
    fs.rmSync(path.join(evidenceRoot, 'fixture-manifest.json'), { force: true });
    const baseContexts = {};
    const armManifests = {};
    for (const arm of arms) {
        removeManagedDirectory(path.join(fixturesRoot, arm), fixturesRoot);
        ensureDirectory(path.join(fixturesRoot, arm));
        const { initialized, initRoot, migrationTags } = await initializeDatabaseFromArm(arm);
        const base = fixturePathByArm[arm].base;
        fs.copyFileSync(initialized, base);
        configureBaseFixture(base);
        baseContexts[arm] = {
            base,
            initRoot,
            migrationTags,
        };
    }
    for (const arm of arms) {
        const { base, initRoot, migrationTags } = baseContexts[arm];
        const integrity = runSync('sqlite3', [base, 'PRAGMA integrity_check;'], {
            log: path.join(logsRoot, `fixture-integrity-${arm}.log`),
        }).stdout.trim();
        if (integrity !== 'ok') {
            throw new Error(`${arm} base fixture integrity check failed: ${integrity}`);
        }
        for (const level of fixtureLevels) {
            const destination = fixturePathByArm[arm][`long-${level}`];
            createLongFixture(base, level, destination);
            const counts = runSync(
                'sqlite3',
                [
                    destination,
                    `SELECT
                        (SELECT COUNT(*) FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.session_id = 'perf-long-${level}'),
                        (SELECT MIN(length(content)) FROM message_parts p JOIN messages m ON m.id = p.message_id JOIN sessions s ON s.id = m.session_id WHERE s.session_id = 'perf-long-${level}'),
                        (SELECT MAX(length(content)) FROM message_parts p JOIN messages m ON m.id = p.message_id JOIN sessions s ON s.id = m.session_id WHERE s.session_id = 'perf-long-${level}');`,
                ],
                { log: path.join(logsRoot, `fixture-check-long-${level}-${arm}.log`) }
            ).stdout.trim();
            const [messageCount, minBytes, maxBytes] = counts.split('|').map(Number);
            if (messageCount !== level || minBytes < 10240 || maxBytes < 10240) {
                throw new Error(
                    `${arm} long fixture ${level} is malformed: messages=${messageCount}, content=${minBytes}..${maxBytes}`
                );
            }
        }
        armManifests[arm] = {
            sourceBinarySha256: sha256File(binaryPathByArm[arm]),
            migrationTags,
            fixtures: Object.fromEntries(
                Object.entries(fixturePathByArm[arm]).map(([name, file]) => [
                    name,
                    {
                        path: file,
                        sha256: sha256File(file),
                    },
                ])
            ),
        };
        removeManagedDirectory(initRoot, artifactsRoot);
    }
    const businessProjection = buildBusinessProjection(
        armManifests.baseline.fixtures.base.path,
        armManifests.current.fixtures.base.path,
        path.join(logsRoot, 'fixture-business-projection.log')
    );
    for (const arm of arms) {
        for (const [name, fixture] of Object.entries(armManifests[arm].fixtures)) {
            fixture.businessOracleSha256 = businessOracleSha256(
                fixture.path,
                businessProjection,
                path.join(logsRoot, `fixture-oracle-${name}-${arm}.log`)
            );
        }
    }
    const businessOracles = Object.fromEntries(
        Object.keys(armManifests.baseline.fixtures).map((name) => [
            name,
            {
                baseline: armManifests.baseline.fixtures[name].businessOracleSha256,
                current: armManifests.current.fixtures[name].businessOracleSha256,
            },
        ])
    );
    for (const [name, oracle] of Object.entries(businessOracles)) {
        if (oracle.baseline !== oracle.current) {
            throw new Error(
                `Fixture ${name} business data differs between arms: baseline=${oracle.baseline}, current=${oracle.current}`
            );
        }
    }
    const manifest = {
        version: MANIFEST_VERSION,
        generatedAt: nowIso(),
        comparison: readComparison(),
        modelEndpoint,
        arms: armManifests,
        businessOracles,
    };
    for (const arm of arms) {
        for (const fixture of Object.values(armManifests[arm].fixtures)) {
            fixture.path = path.relative(evidenceRoot, fixture.path);
        }
    }
    writeJson(path.join(evidenceRoot, 'fixture-manifest.json'), manifest);
    return manifest;
}
