import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldRetryDisplayStartupFailure } from './display-retry.mjs';
import { startPerfModelServer } from './local-model-server.mjs';

const MANIFEST_VERSION = 1;
const MAX_DISPLAY_STARTUP_ATTEMPTS = 2;
const BASELINE_COMMIT = '21e261a1343087d7dc75414dbb46a12a98630da6';
const DEFAULT_PORT = readPort(process.env.TOUCHAI_PERF_PORT ?? 3426);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../../../..');
const evidenceRoot = path.resolve(
    process.env.TOUCHAI_PERF_EVIDENCE ?? '/root/.cache/touchai-verify/710/perf-20261101'
);
const artifactsRoot = path.resolve(
    process.env.TOUCHAI_PERF_ARTIFACTS ?? '/root/build/touchai-perf710'
);
const snapshotsRoot = path.join(artifactsRoot, 'snapshots');
const buildTarget = path.join(artifactsRoot, 'target');
const runtimeRoot = path.join(artifactsRoot, 'runtime');
const logsRoot = path.join(evidenceRoot, 'logs');
const rawRoot = path.join(evidenceRoot, 'raw', 'formal');
const fixturesRoot = path.join(evidenceRoot, 'fixtures');
const manifestsRoot = path.join(evidenceRoot, 'manifests');
const binariesRoot = path.join(evidenceRoot, 'binaries');
const cgroupExec = path.join(scriptDir, 'cgroup-exec.sh');
const initAppRoot = path.join(scriptDir, 'init-app-root.sh');
const memorySampler = path.join(scriptDir, 'process-memory.mjs');
const desktopRoot = path.join(repoRoot, 'apps/desktop');
const wdioConfigRoot = path.join(desktopRoot, 'e2e-tests');
const wdioBinary = path.join(desktopRoot, 'node_modules/.bin/wdio');
const xvfbRunWithWm = path.join(scriptDir, 'xvfb-run-with-wm.sh');
const currentSnapshot = path.join(snapshotsRoot, 'current');
const baselineSnapshot = path.join(snapshotsRoot, 'baseline');
const armOrder = ['baseline', 'current', 'current', 'baseline'];
const binaryPathByArm = {
    baseline: path.join(binariesRoot, 'baseline', 'TouchAI'),
    current: path.join(binariesRoot, 'current', 'TouchAI'),
};
const fixtureNames = ['base', 'long-100', 'long-500', 'long-1000', 'long-1500'];
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
const fixturePathByArm = Object.fromEntries(
    ['baseline', 'current'].map((arm) => [
        arm,
        Object.fromEntries(
            fixtureNames.map((name) => [
                name,
                path.join(
                    fixturesRoot,
                    arm,
                    name === 'base' ? 'fixture-base.db' : `fixture-${name}.db`
                ),
            ])
        ),
    ])
);

function parseArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            values[key] = next;
            index += 1;
        } else {
            values[key] = 'true';
        }
    }
    return values;
}

function readPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error(`Invalid performance model port: ${value}`);
    }
    return port;
}

function numberArg(args, name, fallback) {
    const value = Number(args[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberArg(args, name, fallback) {
    const value = Number(args[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
}

function assertManagedPath(candidate, parent) {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedParent = `${path.resolve(parent)}${path.sep}`;
    if (!resolvedCandidate.startsWith(resolvedParent)) {
        throw new Error(`Refusing to remove unmanaged path: ${resolvedCandidate}`);
    }
}

function removeManagedDirectory(directory, parent) {
    assertManagedPath(directory, parent);
    fs.rmSync(directory, { recursive: true, force: true });
}

function appendLog(file, text) {
    ensureDirectory(path.dirname(file));
    fs.appendFileSync(file, text);
}

function commandLine(command, args) {
    return [command, ...args]
        .map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)))
        .join(' ');
}

function nowIso() {
    return new Date().toISOString();
}

function writeJson(file, value) {
    ensureDirectory(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(value) {
    return createHash('sha256').update(value).digest('hex');
}

function runSync(command, args, options = {}) {
    const startedAt = Date.now();
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repoRoot,
        env: options.env ?? process.env,
        encoding: options.encoding ?? 'utf8',
        input: options.input,
        maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    });
    const record = {
        command: commandLine(command, args),
        cwd: options.cwd ?? repoRoot,
        exitCode: result.status,
        signal: result.signal,
        elapsedMs: Date.now() - startedAt,
        at: nowIso(),
    };
    if (options.log) {
        appendLog(
            options.log,
            [
                `\n$ ${record.command}`,
                `cwd=${record.cwd}`,
                `exit=${record.exitCode} signal=${record.signal ?? ''} elapsed_ms=${record.elapsedMs}`,
                result.stdout ? `--- stdout ---\n${result.stdout}` : '',
                result.stderr ? `--- stderr ---\n${result.stderr}` : '',
                '',
            ].join('\n')
        );
    }
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        throw new Error(
            `${record.command} failed with exit ${result.status}: ${String(result.stderr).trim()}`
        );
    }
    return { ...record, stdout: result.stdout, stderr: result.stderr };
}

async function runStreaming(command, args, options = {}) {
    ensureDirectory(path.dirname(options.log));
    const descriptor = fs.openSync(options.log, 'a');
    const startedAt = Date.now();
    appendLog(
        options.log,
        `\n$ ${commandLine(command, args)}\ncwd=${options.cwd ?? repoRoot}\nat=${nowIso()}\n`
    );

    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd ?? repoRoot,
            env: options.env ?? process.env,
            stdio: ['ignore', descriptor, descriptor],
        });
        child.once('error', (error) => {
            fs.closeSync(descriptor);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            const result = {
                command: commandLine(command, args),
                cwd: options.cwd ?? repoRoot,
                exitCode: code,
                signal,
                elapsedMs: Date.now() - startedAt,
            };
            appendLog(
                options.log,
                `exit=${code} signal=${signal ?? ''} elapsed_ms=${result.elapsedMs}\n`
            );
            fs.closeSync(descriptor);
            resolve(result);
        });
    });
}

function parseMetricsFile(file) {
    if (!fs.existsSync(file)) return {};
    const metrics = {};
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
        if (!line) continue;
        const [key, value] = line.trim().split(/[=\s]+/, 2);
        metrics[key] = value;
    }
    return metrics;
}

function readJsonLines(file) {
    if (!fs.existsSync(file)) return [];
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
}

function readJsonFile(file) {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isValidRun(record) {
    return (
        record.valid !== false &&
        record.exitCode === 0 &&
        (record.signal === null || record.signal === undefined) &&
        (record.notificationFailures ?? 0) === 0
    );
}

let systemdRunAvailable;

function canUseSystemdRun() {
    if (process.env.TOUCHAI_PERF_DISABLE_CGROUP === '1') return false;
    if (systemdRunAvailable !== undefined) return systemdRunAvailable;
    const probe = spawnSync('systemd-run', ['--user', '--scope', '--collect', '--quiet', 'true'], {
        stdio: 'ignore',
    });
    systemdRunAvailable = probe.status === 0;
    if (!systemdRunAvailable) {
        console.warn('systemd-run --user is unavailable; running without a transient cgroup.');
    }
    return systemdRunAvailable;
}

async function runInCgroup({ label, command, args, cwd, env, log }) {
    const unit = `touchai-perf710-${label}-${Date.now()}`
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-');
    const metricsFile = `${log}.cgroup`;
    fs.rmSync(metricsFile, { force: true });
    const directCommand = ['bash', cgroupExec, command, ...args];
    const useSystemd = canUseSystemdRun();
    const executable = useSystemd ? 'systemd-run' : directCommand[0];
    const executableArgs = useSystemd
        ? [
              '--user',
              '--scope',
              '--collect',
              `--unit=${unit}`,
              '-p',
              'MemoryAccounting=yes',
              '-p',
              `MemoryHigh=${process.env.TOUCHAI_PERF_MEMORY_HIGH ?? '1700M'}`,
              '-p',
              `MemoryMax=${process.env.TOUCHAI_PERF_MEMORY_MAX ?? '2200M'}`,
              '-p',
              `MemorySwapMax=${process.env.TOUCHAI_PERF_MEMORY_SWAP_MAX ?? '2000M'}`,
              '-p',
              `CPUQuota=${process.env.TOUCHAI_PERF_CPU_QUOTA ?? '150%'}`,
              '--nice=10',
              '--',
              ...directCommand,
          ]
        : directCommand.slice(1);
    const result = await runStreaming(executable, executableArgs, {
        cwd,
        env: {
            ...env,
            TOUCHAI_PERF_CGROUP_METRICS: metricsFile,
        },
        log,
    });
    return {
        ...result,
        unit: useSystemd ? unit : null,
        cgroup: parseMetricsFile(metricsFile),
        log,
    };
}

function listSnapshotEntries(root) {
    const entries = [];
    const walk = (directory) => {
        for (const entry of fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name === '.git') continue;
            const absolute = path.join(directory, entry.name);
            const relative = path.relative(root, absolute);
            if (entry.isSymbolicLink()) {
                const target = fs.readlinkSync(absolute);
                entries.push({
                    path: relative,
                    type: 'symlink',
                    target,
                    sha256: sha256Text(target),
                });
            } else if (entry.isDirectory()) {
                walk(absolute);
            } else if (entry.isFile()) {
                entries.push({
                    path: relative,
                    type: 'file',
                    size: fs.statSync(absolute).size,
                    sha256: sha256File(absolute),
                });
            }
        }
    };
    walk(root);
    return entries;
}

function writeSourceManifest(arm, snapshot) {
    const entries = listSnapshotEntries(snapshot);
    const manifest = {
        version: MANIFEST_VERSION,
        arm,
        baselineCommit: BASELINE_COMMIT,
        generatedAt: nowIso(),
        snapshot,
        entries,
        entryCount: entries.length,
    };
    const manifestPath = path.join(manifestsRoot, `${arm}-source-manifest.json`);
    writeJson(manifestPath, manifest);
    return {
        path: manifestPath,
        sha256: sha256File(manifestPath),
        entryCount: entries.length,
    };
}

function linkNodeModules(snapshot) {
    const links = [
        [path.join(repoRoot, 'node_modules'), path.join(snapshot, 'node_modules')],
        [path.join(desktopRoot, 'node_modules'), path.join(snapshot, 'apps/desktop/node_modules')],
    ];
    for (const [source, target] of links) {
        if (!fs.existsSync(source)) {
            throw new Error(`Required node_modules is missing: ${source}`);
        }
        fs.rmSync(target, { recursive: true, force: true });
        fs.symlinkSync(source, target, 'dir');
    }
}

function prepareBaselineSnapshot() {
    removeManagedDirectory(baselineSnapshot, snapshotsRoot);
    ensureDirectory(baselineSnapshot);
    const archive = path.join(artifactsRoot, 'baseline.tar');
    runSync('git', ['archive', '--format=tar', `--output=${archive}`, BASELINE_COMMIT], {
        cwd: repoRoot,
        log: path.join(logsRoot, 'prepare.log'),
    });
    runSync('tar', ['-xf', archive, '-C', baselineSnapshot], {
        cwd: repoRoot,
        log: path.join(logsRoot, 'prepare.log'),
    });
    fs.rmSync(archive, { force: true });
}

function prepareCurrentSnapshot() {
    removeManagedDirectory(currentSnapshot, snapshotsRoot);
    ensureDirectory(currentSnapshot);
    const archive = path.join(artifactsRoot, 'current.tar');
    const excludes = [
        '.git',
        'node_modules',
        'apps/desktop/node_modules',
        'apps/desktop/dist',
        'apps/desktop/src-tauri/target',
        '.e2e-runtime',
        'target',
        'rust-target',
        'rust-temp',
    ].flatMap((entry) => [`--exclude=${entry}`, `--exclude=./${entry}`]);
    runSync('tar', ['-C', repoRoot, ...excludes, '-cf', archive, '.'], {
        cwd: repoRoot,
        log: path.join(logsRoot, 'prepare.log'),
    });
    runSync('tar', ['-C', currentSnapshot, '-xf', archive], {
        cwd: repoRoot,
        log: path.join(logsRoot, 'prepare.log'),
    });
    fs.rmSync(archive, { force: true });
}

function recordWorktreeEvidence() {
    const status = runSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: repoRoot,
    });
    const diff = runSync('git', ['diff', '--binary', '--no-ext-diff'], {
        cwd: repoRoot,
        maxBuffer: 512 * 1024 * 1024,
    });
    const head = runSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim();
    const branch = runSync('git', ['branch', '--show-current'], { cwd: repoRoot }).stdout.trim();
    const statusPath = path.join(manifestsRoot, 'worktree-status.txt');
    const diffPath = path.join(manifestsRoot, 'worktree.diff');
    fs.writeFileSync(statusPath, status.stdout);
    fs.writeFileSync(diffPath, diff.stdout);
    return {
        head,
        baselineCommit: BASELINE_COMMIT,
        branch,
        statusPath,
        statusSha256: sha256File(statusPath),
        diffPath,
        diffSha256: sha256File(diffPath),
        statusEntries: status.stdout.trim() ? status.stdout.trim().split('\n').length : 0,
    };
}

function prepareSnapshots() {
    ensureDirectory(logsRoot);
    ensureDirectory(manifestsRoot);
    prepareBaselineSnapshot();
    prepareCurrentSnapshot();
    linkNodeModules(baselineSnapshot);
    linkNodeModules(currentSnapshot);
    const worktree = recordWorktreeEvidence();
    const manifest = {
        version: MANIFEST_VERSION,
        generatedAt: nowIso(),
        repoRoot,
        evidenceRoot,
        artifactsRoot,
        baselineCommit: BASELINE_COMMIT,
        worktree,
        baseline: writeSourceManifest('baseline', baselineSnapshot),
        current: writeSourceManifest('current', currentSnapshot),
        environment: {
            node: process.version,
            pnpm: runSync('pnpm', ['--version']).stdout.trim(),
            rustc: runSync('rustc', ['--version']).stdout.trim(),
            cargo: runSync('cargo', ['--version']).stdout.trim(),
            webkit: runSync('bash', [
                '-lc',
                "dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0 2>/dev/null || true",
            ]).stdout.trim(),
            kernel: os.release(),
            platform: `${process.platform}-${process.arch}`,
            cpuCount: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
            ci: {
                provider: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
                workflow: process.env.GITHUB_WORKFLOW ?? null,
                runId: process.env.GITHUB_RUN_ID ?? null,
                runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
                runnerName: process.env.RUNNER_NAME ?? null,
                runnerOs: process.env.RUNNER_OS ?? null,
                imageOs: process.env.ImageOS ?? null,
                imageVersion: process.env.ImageVersion ?? null,
            },
        },
    };
    const manifestPath = path.join(evidenceRoot, 'source-manifest.json');
    writeJson(manifestPath, manifest);
    return manifest;
}

async function buildArm(arm) {
    const snapshot = arm === 'baseline' ? baselineSnapshot : currentSnapshot;
    const tauriBinary = path.join(snapshot, 'apps/desktop/node_modules/.bin/tauri');
    if (!fs.existsSync(tauriBinary)) {
        throw new Error(`Tauri CLI is missing from ${snapshot}.`);
    }
    removeManagedDirectory(buildTarget, artifactsRoot);
    const tmp = path.join(artifactsRoot, 'tmp', arm);
    removeManagedDirectory(tmp, artifactsRoot);
    ensureDirectory(tmp);
    ensureDirectory(buildTarget);
    const log = path.join(logsRoot, `build-${arm}.log`);
    const env = {
        ...process.env,
        CARGO_BUILD_JOBS: process.env.TOUCHAI_PERF_CARGO_JOBS ?? '1',
        CARGO_INCREMENTAL: '0',
        CARGO_PROFILE_RELEASE_DEBUG: '0',
        CARGO_TARGET_DIR: buildTarget,
        NODE_OPTIONS: '--max-old-space-size=2048',
        TMP: tmp,
        TEMP: tmp,
    };

    let result;
    try {
        result = await runInCgroup({
            label: `build-${arm}`,
            command: tauriBinary,
            args: ['build', '--no-bundle'],
            cwd: path.join(snapshot, 'apps/desktop'),
            env,
            log,
        });
        if (result.exitCode !== 0) {
            throw new Error(`Fat-LTO release build for ${arm} exited ${result.exitCode}.`);
        }
        const outputBinary = path.join(buildTarget, 'release/TouchAI');
        if (!fs.existsSync(outputBinary)) {
            throw new Error(`Release binary was not produced at ${outputBinary}.`);
        }
        const destination = binaryPathByArm[arm];
        ensureDirectory(path.dirname(destination));
        fs.copyFileSync(outputBinary, destination);
        fs.chmodSync(destination, 0o755);
        return {
            ...result,
            arm,
            binary: destination,
            binarySha256: sha256File(destination),
            binarySize: fs.statSync(destination).size,
        };
    } finally {
        removeManagedDirectory(buildTarget, artifactsRoot);
        removeManagedDirectory(tmp, artifactsRoot);
    }
}

async function buildBoth() {
    ensureDirectory(logsRoot);
    const results = [];
    for (const arm of ['baseline', 'current']) {
        const result = await buildArm(arm);
        results.push(result);
        writeJson(path.join(evidenceRoot, 'builds.json'), {
            generatedAt: nowIso(),
            builds: results,
        });
    }
    return results;
}

async function initializeDatabaseFromArm(arm) {
    const binary = binaryPathByArm[arm];
    if (!fs.existsSync(binary)) {
        throw new Error(`The ${arm} release binary is missing: ${binary}`);
    }
    const initRoot = path.join(artifactsRoot, 'fixture-init-root', arm);
    removeManagedDirectory(initRoot, artifactsRoot);
    ensureDirectory(initRoot);
    const log = path.join(logsRoot, `fixture-init-${arm}.log`);
    const displayLogDir = path.join(logsRoot, `fixture-init-display-${arm}`);
    const result = await runInCgroup({
        label: `fixture-init-${arm}`,
        command: xvfbRunWithWm,
        args: ['bash', initAppRoot, binary, initRoot, '120'],
        cwd: repoRoot,
        env: {
            ...process.env,
            TOUCHAI_APP_ROOT: initRoot,
            TOUCHAI_E2E: '1',
            TOUCHAI_PERF_RUN_TOKEN: `fixture-init-${arm}`,
            TOUCHAI_PERF_RUN_LOG_DIR: displayLogDir,
            GDK_BACKEND: 'x11',
            NO_AT_BRIDGE: '1',
        },
        log,
    });
    const initialized = path.join(initRoot, 'data/touchai.db');
    if (result.exitCode !== 0 || !fs.existsSync(initialized)) {
        throw new Error(`Database initialization failed for ${arm}. See ${log}.`);
    }
    const checkpoint = runSync('sqlite3', [initialized, 'PRAGMA wal_checkpoint(TRUNCATE);'], {
        log: path.join(logsRoot, `fixture-checkpoint-${arm}.log`),
    }).stdout.trim();
    if (!/^0(?:\||$)/.test(checkpoint)) {
        throw new Error(`${arm} database WAL checkpoint was busy: ${checkpoint}`);
    }
    const wal = `${initialized}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
        throw new Error(`${arm} database WAL was not checkpointed: ${wal}`);
    }
    const migrationTags = runSync(
        'sqlite3',
        [initialized, 'SELECT hash FROM migrations ORDER BY id;'],
        {
            log: path.join(logsRoot, `fixture-migrations-${arm}.log`),
        }
    )
        .stdout.trim()
        .split('\n')
        .filter(Boolean);
    return { initialized, initRoot, result, migrationTags };
}

function runSqlite(database, sql, log) {
    return runSync('sqlite3', [database], {
        input: sql,
        log,
        cwd: repoRoot,
    });
}

function configureBaseFixture(database) {
    const sql = `
BEGIN IMMEDIATE;
DELETE FROM models;
UPDATE providers SET enabled = 0;
UPDATE providers
SET enabled = 1,
    api_endpoint = 'http://127.0.0.1:${DEFAULT_PORT}/v1',
    api_key = 'perf-only',
    config_json = NULL,
    updated_at = datetime('now')
WHERE name = 'Magpie' AND driver = 'openai-compatible';
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
WHERE name = 'Magpie' AND driver = 'openai-compatible';
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
VACUUM;
`;
    runSqlite(database, sql, path.join(logsRoot, 'fixture-configure.log'));
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
WHERE name = 'Magpie' AND driver = 'openai-compatible';

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

async function prepareFixtures() {
    ensureDirectory(fixturesRoot);
    const arms = ['baseline', 'current'];
    const armManifests = {};
    for (const arm of arms) {
        removeManagedDirectory(path.join(fixturesRoot, arm), fixturesRoot);
        ensureDirectory(path.join(fixturesRoot, arm));
        const { initialized, initRoot, migrationTags } = await initializeDatabaseFromArm(arm);
        const base = fixturePathByArm[arm].base;
        fs.copyFileSync(initialized, base);
        configureBaseFixture(base);
        const integrity = runSync('sqlite3', [base, 'PRAGMA integrity_check;'], {
            log: path.join(logsRoot, `fixture-integrity-${arm}.log`),
        }).stdout.trim();
        if (integrity !== 'ok') {
            throw new Error(`${arm} base fixture integrity check failed: ${integrity}`);
        }
        for (const level of [100, 500, 1000, 1500]) {
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
            sourceBinary: binaryPathByArm[arm],
            sourceBinarySha256: sha256File(binaryPathByArm[arm]),
            migrationTags,
            fixtures: Object.fromEntries(
                Object.entries(fixturePathByArm[arm]).map(([name, file]) => [
                    name,
                    {
                        path: file,
                        sha256: sha256File(file),
                        size: fs.statSync(file).size,
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
        fixtureNames.map((name) => [
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
        provider: {
            name: 'Magpie',
            driver: 'openai-compatible',
            endpoint: `http://127.0.0.1:${DEFAULT_PORT}/v1`,
        },
        model: {
            id: 'perf-model',
            toolCall: true,
            reasoning: true,
            contextLimit: 131072,
            outputLimit: 16384,
        },
        historyBytesPerMessage: 10240,
        historyContentBytes: { minimum: 10240, includesMessagePrefix: true },
        arms: armManifests,
        businessOracleColumns: businessProjection,
        businessOracles,
    };
    writeJson(path.join(evidenceRoot, 'fixture-manifest.json'), manifest);
    return manifest;
}

function ensureEvidenceLayout(resume = false) {
    for (const directory of [
        artifactsRoot,
        snapshotsRoot,
        runtimeRoot,
        logsRoot,
        rawRoot,
        fixturesRoot,
        manifestsRoot,
        binariesRoot,
    ]) {
        ensureDirectory(directory);
    }
    for (const file of [
        path.join(rawRoot, 'events.jsonl'),
        path.join(rawRoot, 'pss.jsonl'),
        path.join(rawRoot, 'runs.jsonl'),
        path.join(rawRoot, 'model-server.jsonl'),
    ]) {
        if (resume) {
            fs.closeSync(fs.openSync(file, 'a'));
        } else {
            fs.writeFileSync(file, '');
        }
    }
}

function stopChild(child, signal = 'SIGTERM') {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null) {
            resolve();
            return;
        }
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
        }, 5000);
        child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
        child.kill(signal);
    });
}

function copyIfExists(source, destination) {
    if (!fs.existsSync(source)) return;
    fs.cpSync(source, destination, { recursive: true, force: true });
}

function countNotificationFailures(runLogDir) {
    const appLogDir = path.join(runLogDir, 'app-logs');
    if (!fs.existsSync(appLogDir)) return 0;

    let count = 0;
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(file);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
            const text = fs.readFileSync(file, 'utf8');
            count += text.split('Failed to send session status reminder notification').length - 1;
        }
    };
    visit(appLogDir);
    return count;
}

function hasRunStarted(runId) {
    return readJsonLines(path.join(rawRoot, 'events.jsonl')).some(
        (record) => record.runId === runId && record.type === 'run-start'
    );
}

function readDisplayFailureLog(runLogDir, wdioLog) {
    return [wdioLog, path.join(runLogDir, 'dunst.log'), path.join(runLogDir, 'openbox.log')]
        .filter((file) => fs.existsSync(file))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');
}

async function runOneMeasurement({
    arm,
    flow,
    block,
    sequenceIndex,
    fixture,
    historyLevel,
    options,
    attempt = 1,
}) {
    const binary = binaryPathByArm[arm];
    if (!fs.existsSync(binary)) throw new Error(`Missing ${arm} release binary.`);
    const fixtureFile = fixturePathByArm[arm]?.[fixture];
    if (!fixtureFile) throw new Error(`Unknown ${arm} fixture: ${fixture}`);
    if (!fs.existsSync(fixtureFile)) throw new Error(`Missing fixture: ${fixtureFile}`);

    const runId = [
        flow,
        historyLevel ? `h${historyLevel}` : null,
        `b${block}`,
        `s${sequenceIndex}`,
        arm,
        attempt > 1 ? `r${attempt}` : null,
        Date.now(),
    ]
        .filter(Boolean)
        .join('-');
    const appRoot = path.join(runtimeRoot, runId);
    const runLogDir = path.join(logsRoot, 'runs', runId);
    removeManagedDirectory(appRoot, runtimeRoot);
    ensureDirectory(path.join(appRoot, 'data'));
    ensureDirectory(path.join(appRoot, 'tmp'));
    ensureDirectory(runLogDir);
    const runDatabase = path.join(appRoot, 'data/touchai.db');
    fs.copyFileSync(fixtureFile, runDatabase);
    const fixtureSha256 = sha256File(runDatabase);
    const pssLog = path.join(runLogDir, 'pss-sampler.log');
    const samplerStdout = fs.openSync(pssLog, 'a');
    const samplerStderr = fs.openSync(pssLog, 'a');
    let samplerLogClosed = false;
    const closeSamplerLog = () => {
        if (samplerLogClosed) return;
        samplerLogClosed = true;
        fs.closeSync(samplerStdout);
        fs.closeSync(samplerStderr);
    };
    const sampler = spawn(
        process.execPath,
        [
            memorySampler,
            '--app-root',
            appRoot,
            '--out',
            path.join(rawRoot, 'pss.jsonl'),
            '--run-id',
            runId,
            '--arm',
            arm,
            '--flow',
            flow,
            '--run-token',
            runId,
            '--interval-ms',
            String(options.memoryIntervalMs),
        ],
        {
            cwd: repoRoot,
            env: process.env,
            stdio: ['ignore', samplerStdout, samplerStderr],
        }
    );
    sampler.once('exit', closeSamplerLog);
    sampler.once('error', closeSamplerLog);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const wdioLog = path.join(runLogDir, 'wdio.log');
    const env = {
        ...process.env,
        GDK_BACKEND: 'x11',
        NO_AT_BRIDGE: '1',
        NODE_OPTIONS: '--max-old-space-size=1536',
        TEMP: path.join(appRoot, 'tmp'),
        TMP: path.join(appRoot, 'tmp'),
        TMPDIR: path.join(appRoot, 'tmp'),
        TOUCHAI_APP_ROOT: appRoot,
        TOUCHAI_PERF_ARM: arm,
        TOUCHAI_PERF_APP_ROOT: appRoot,
        TOUCHAI_PERF_BINARY: binary,
        TOUCHAI_PERF_BLOCK: String(block),
        TOUCHAI_PERF_EVENTS: path.join(rawRoot, 'events.jsonl'),
        TOUCHAI_PERF_FLOW: flow,
        TOUCHAI_PERF_HISTORY_LEVEL: String(historyLevel || 0),
        TOUCHAI_PERF_PROGRESS_TASKS: String(options.progressTasks),
        TOUCHAI_PERF_PROGRESS_WARMUPS: String(options.progressWarmups),
        TOUCHAI_PERF_RUN_ID: runId,
        TOUCHAI_PERF_RUN_LOG_DIR: runLogDir,
        TOUCHAI_PERF_RUN_TOKEN: runId,
        TOUCHAI_PERF_WARM_SAMPLES: String(options.warmSamples),
    };
    let result;
    try {
        result = await runInCgroup({
            label: `run-${flow}`,
            command: xvfbRunWithWm,
            args: [wdioBinary, 'run', 'wdio.perf.conf.js'],
            cwd: wdioConfigRoot,
            env,
            log: wdioLog,
        });
    } finally {
        await stopChild(sampler, 'SIGINT');
    }
    copyIfExists(path.join(appRoot, 'logs'), path.join(runLogDir, 'app-logs'));
    const notificationFailures = countNotificationFailures(runLogDir);
    const invalidReasons = [];
    if (result.signal) {
        invalidReasons.push(`WebDriver signal ${result.signal}`);
    }
    if (result.exitCode !== 0) {
        invalidReasons.push(`WebDriver exit ${result.exitCode}`);
    }
    if (notificationFailures > 0) {
        invalidReasons.push(
            `${notificationFailures} native notification failure${notificationFailures === 1 ? '' : 's'}`
        );
    }
    const valid = invalidReasons.length === 0;
    const retryDisplayStartup =
        !valid &&
        attempt < MAX_DISPLAY_STARTUP_ATTEMPTS &&
        shouldRetryDisplayStartupFailure({
            runStarted: hasRunStarted(runId),
            exitCode: result.exitCode,
            signal: result.signal,
            logText: readDisplayFailureLog(runLogDir, wdioLog),
        });

    const record = {
        type: retryDisplayStartup ? 'run-attempt' : 'run',
        at: nowIso(),
        arm,
        flow,
        block,
        sequenceIndex,
        runId,
        historyLevel: historyLevel || null,
        fixture,
        fixtureSha256,
        binary,
        binarySha256: sha256File(binary),
        exitCode: result.exitCode,
        signal: result.signal,
        elapsedMs: result.elapsedMs,
        cgroup: result.cgroup,
        notificationFailures,
        valid,
        invalidReasons,
        retryReason: retryDisplayStartup ? 'display-startup-failure' : null,
        log: wdioLog,
    };
    fs.appendFileSync(path.join(rawRoot, 'runs.jsonl'), `${JSON.stringify(record)}\n`);

    if (retryDisplayStartup) {
        const failureRoot = path.join(evidenceRoot, 'failures', runId);
        ensureDirectory(failureRoot);
        copyIfExists(appRoot, path.join(failureRoot, 'app-root'));
        removeManagedDirectory(appRoot, runtimeRoot);
        console.warn(
            `Performance run ${runId} did not start because the display stack failed; retrying once.`
        );
        return runOneMeasurement({
            arm,
            flow,
            block,
            sequenceIndex,
            fixture,
            historyLevel,
            options,
            attempt: attempt + 1,
        });
    }

    if (!valid) {
        const failureRoot = path.join(evidenceRoot, 'failures', runId);
        ensureDirectory(failureRoot);
        copyIfExists(appRoot, path.join(failureRoot, 'app-root'));
        throw new Error(
            `Performance run ${runId} is invalid: ${invalidReasons.join('; ')}. See ${wdioLog}.`
        );
    }

    removeManagedDirectory(appRoot, runtimeRoot);
    return record;
}

function buildRunPlan(options) {
    const plan = [];
    if (options.flows.includes('latency')) {
        for (let block = 1; block <= options.latencyBlocks; block += 1) {
            armOrder.forEach((arm, index) => {
                plan.push({
                    arm,
                    flow: 'latency',
                    block,
                    sequenceIndex: index + 1,
                    fixture: 'base',
                    historyLevel: 0,
                });
            });
        }
    }
    if (options.flows.includes('progress')) {
        for (let block = 1; block <= options.progressBlocks; block += 1) {
            armOrder.forEach((arm, index) => {
                plan.push({
                    arm,
                    flow: 'progress',
                    block,
                    sequenceIndex: index + 1,
                    fixture: 'base',
                    historyLevel: 0,
                });
            });
        }
    }
    if (options.flows.includes('long-session')) {
        for (const historyLevel of options.historyLevels) {
            for (let block = 1; block <= options.longBlocks; block += 1) {
                armOrder.forEach((arm, index) => {
                    plan.push({
                        arm,
                        flow: 'long-session',
                        block,
                        sequenceIndex: index + 1,
                        fixture: `long-${historyLevel}`,
                        historyLevel,
                    });
                });
            }
        }
    }
    return plan;
}

function measurementKey(item) {
    return [item.flow, item.block, item.sequenceIndex, item.arm, item.historyLevel || 0].join(':');
}

async function runMeasurements(options) {
    ensureEvidenceLayout(options.resume);
    const plan = buildRunPlan(options);
    const runsPath = path.join(rawRoot, 'runs.jsonl');
    const existingSuccessfulRuns = readJsonLines(runsPath).filter(
        (record) => record.type === 'run' && isValidRun(record)
    );
    const completedKeys = new Set(existingSuccessfulRuns.map(measurementKey));
    const remainingPlan = options.resume
        ? plan.filter((item) => !completedKeys.has(measurementKey(item)))
        : plan;
    const results = options.resume
        ? existingSuccessfulRuns.filter((record) =>
              plan.some((item) => measurementKey(item) === measurementKey(record))
          )
        : [];
    const previousPlan = options.resume
        ? readJsonFile(path.join(evidenceRoot, 'run-plan.json'))
        : null;
    const protocol = previousPlan?.protocol ?? {
        flows: options.flows,
        latencyBlocks: options.latencyBlocks,
        progressBlocks: options.progressBlocks,
        longBlocks: options.longBlocks,
        historyLevels: options.historyLevels,
        warmSamples: options.warmSamples,
        progressWarmups: options.progressWarmups,
        progressTasks: options.progressTasks,
        startupSettleMs: Number(process.env.TOUCHAI_PERF_STARTUP_SETTLE_MS ?? 8000),
        armOrder,
        display: 'xvfb-openbox-dunst-dbus',
        windowManager: 'openbox',
        notificationDaemon: 'dunst',
    };
    writeJson(path.join(evidenceRoot, 'run-plan.json'), {
        generatedAt: nowIso(),
        options,
        protocol,
        plan,
        remainingPlan,
    });
    if (options.dryRun) {
        console.log(JSON.stringify(remainingPlan, null, 2));
        return [];
    }
    const server = await startPerfModelServer({
        port: DEFAULT_PORT,
        logFile: path.join(rawRoot, 'model-server.jsonl'),
    });
    try {
        for (const [index, item] of remainingPlan.entries()) {
            console.log(
                `[${index + 1}/${remainingPlan.length}] ${item.flow} ${item.historyLevel || ''} block ${item.block} ${item.arm}`
            );
            results.push(await runOneMeasurement({ ...item, options }));
        }
    } finally {
        await server.close();
    }
    writeJson(path.join(evidenceRoot, 'run-results.json'), {
        generatedAt: nowIso(),
        results,
    });
    return results;
}

function readOptions(args) {
    return {
        flows: (args.flows ?? 'latency,progress,long-session').split(',').filter(Boolean),
        latencyBlocks: numberArg(args, 'latency-blocks', 5),
        progressBlocks: numberArg(args, 'progress-blocks', 3),
        longBlocks: numberArg(args, 'long-blocks', 6),
        // Keep the default formal levels reproducible; 1500 remains available
        // as an explicit diagnostic because it is not stable on the 3.6 GiB VM.
        historyLevels: (args['history-levels'] ?? '100,500,1000')
            .split(',')
            .map(Number)
            .filter((value) => Number.isFinite(value) && value > 0),
        warmSamples: nonNegativeNumberArg(args, 'warm-samples', 8),
        progressWarmups: numberArg(args, 'progress-warmups', 4),
        // Two 16-task pilot attempts hit the same JSC crash at the 16th task.
        progressTasks: numberArg(args, 'progress-tasks', 8),
        memoryIntervalMs: numberArg(args, 'memory-interval-ms', 250),
        modelPort: DEFAULT_PORT,
        dryRun: args['dry-run'] === 'true',
        resume: args.resume === 'true',
    };
}

async function main() {
    const [command = 'all', ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);
    ensureDirectory(logsRoot);
    ensureDirectory(evidenceRoot);

    if (command === 'prepare') {
        const manifest = prepareSnapshots();
        console.log(
            `Prepared snapshots. Current manifest ${manifest.current.sha256}; baseline ${manifest.baseline.sha256}.`
        );
        return;
    }
    if (command === 'build') {
        const builds = await buildBoth();
        for (const build of builds) {
            console.log(
                `${build.arm}: ${build.binarySha256} (${build.binarySize} bytes, ${build.elapsedMs}ms)`
            );
        }
        return;
    }
    if (command === 'fixture') {
        const manifest = await prepareFixtures();
        console.log(JSON.stringify(manifest.arms, null, 2));
        return;
    }
    if (command === 'run') {
        await runMeasurements(readOptions(args));
        return;
    }
    if (command === 'stats') {
        const { generateStats } = await import('./stats.mjs');
        await generateStats();
        return;
    }
    if (command === 'all') {
        prepareSnapshots();
        await buildBoth();
        await prepareFixtures();
        await runMeasurements(readOptions(args));
        const { generateStats } = await import('./stats.mjs');
        await generateStats();
        return;
    }

    throw new Error(
        'Usage: run.mjs <prepare|build|fixture|run|stats|all> [--flows ...] [--dry-run] [--resume]'
    );
}

main().catch((error) => {
    const log = path.join(logsRoot, 'runner-error.log');
    appendLog(log, `\nat=${nowIso()}\n${error?.stack ?? String(error)}\n`);
    console.error(error);
    process.exitCode = 1;
});
