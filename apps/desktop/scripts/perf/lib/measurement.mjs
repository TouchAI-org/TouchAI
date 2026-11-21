import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    artifactsRoot,
    binaryPathByArm,
    evidenceRoot,
    fixturePathByArm,
    logsRoot,
    MAX_DISPLAY_STARTUP_ATTEMPTS,
    memorySampler,
    rawRoot,
    repoRoot,
    runtimeRoot,
    wdioBinary,
    wdioConfigRoot,
    xvfbRunWithWm,
} from './config.mjs';
import {
    copyIfExists,
    ensureDirectory,
    nowIso,
    readJsonLines,
    removeManagedDirectory,
    sha256File,
} from './io.mjs';
import { runInCgroup } from './process.mjs';

const DISPLAY_STARTUP_FAILURES = [
    'Dunst did not register org.freedesktop.Notifications',
    'Openbox did not become ready',
    'Cannot open X11 display',
    "Couldn't initialize X11 output",
    'X connection broke',
];

export function shouldRetryDisplayStartupFailure({ runStarted, exitCode, signal, logText }) {
    if (runStarted) return false;
    if (exitCode === 0 && !signal) return false;
    return DISPLAY_STARTUP_FAILURES.some((signature) => logText.includes(signature));
}

function stopChild(child, signal = 'SIGTERM') {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null || child.signalCode !== null) {
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

function appendRunRecord(record) {
    fs.appendFileSync(path.join(rawRoot, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
}

function readDisplayFailureLog(runLogDir, wdioLog) {
    return [wdioLog, path.join(runLogDir, 'dunst.log'), path.join(runLogDir, 'openbox.log')]
        .filter((file) => fs.existsSync(file))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');
}

export function measurementInvalidReasons({
    exitCode,
    signal,
    notificationFailures,
    samplerFailure,
    launchError = null,
}) {
    const reasons = [];
    if (launchError) {
        const message = launchError instanceof Error ? launchError.message : String(launchError);
        reasons.push(`measurement launch failed: ${message}`);
    }
    if (!launchError && signal) reasons.push(`WebDriver signal ${signal}`);
    if (!launchError && exitCode !== 0) reasons.push(`WebDriver exit ${exitCode}`);
    if (notificationFailures > 0) {
        reasons.push(
            `${notificationFailures} native notification failure${notificationFailures === 1 ? '' : 's'}`
        );
    }
    if (samplerFailure) reasons.push(`memory sampler ${samplerFailure}`);
    return reasons;
}

/**
 * Records whether the memory sampler exited before the measurement ended.
 * A WebDriver completion that happens later must never erase an earlier
 * sampler exit, otherwise truncated memory evidence looks valid.
 */
export function createSamplerWatch() {
    let exit = null;
    return {
        noteExit(code, signal) {
            exit ??= { code, signal: signal ?? null };
        },
        earlyExit() {
            return exit;
        },
    };
}

export function samplerFailureReason({ earlyExit, error }) {
    if (error) return `failed: ${error.message}`;
    if (!earlyExit) return null;
    return `stopped before WebDriver completed (exit ${earlyExit.code ?? 'null'} signal ${earlyExit.signal ?? 'null'})`;
}

export async function runOneMeasurement({
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
    const binarySha256 = sha256File(binary);
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
    const samplerWatch = createSamplerWatch();
    let samplerError = null;
    sampler.once('exit', closeSamplerLog);
    sampler.once('exit', (code, signal) => samplerWatch.noteExit(code, signal));
    sampler.once('error', (error) => {
        samplerError = error;
        closeSamplerLog();
    });
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
        TOUCHAI_PERF_ARTIFACTS: artifactsRoot,
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
    appendRunRecord({
        type: 'run-launch',
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
        binarySha256,
        attempt,
        log: wdioLog,
    });
    let result = {
        exitCode: null,
        signal: null,
        elapsedMs: null,
        cgroup: {},
    };
    let launchError = null;
    let samplerEarlyExit;
    const launchStartedAt = Date.now();
    try {
        result = await runInCgroup({
            label: `run-${flow}`,
            command: xvfbRunWithWm,
            args: [wdioBinary, 'run', 'wdio.perf.conf.js'],
            cwd: wdioConfigRoot,
            env,
            log: wdioLog,
        });
    } catch (error) {
        launchError = error;
    } finally {
        // Any sampler exit before WebDriver returns leaves the memory series
        // truncated, even when WebDriver itself eventually finishes cleanly.
        samplerEarlyExit = samplerWatch.earlyExit();
        await stopChild(sampler, 'SIGINT');
    }
    copyIfExists(path.join(appRoot, 'logs'), path.join(runLogDir, 'app-logs'));
    const notificationFailures = countNotificationFailures(runLogDir);
    const samplerFailure = samplerFailureReason({
        earlyExit: samplerEarlyExit,
        error: samplerError,
    });
    const invalidReasons = measurementInvalidReasons({
        exitCode: result.exitCode,
        signal: result.signal,
        notificationFailures,
        samplerFailure,
        launchError,
    });
    const valid = invalidReasons.length === 0;
    const retryDisplayStartup =
        !launchError &&
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
        binarySha256,
        attempt,
        exitCode: result.exitCode,
        signal: result.signal,
        elapsedMs: launchError ? Date.now() - launchStartedAt : result.elapsedMs,
        cgroup: result.cgroup,
        notificationFailures,
        valid,
        invalidReasons,
        retryReason: retryDisplayStartup ? 'display-startup-failure' : null,
        log: wdioLog,
    };
    appendRunRecord(record);

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
            `Performance run ${runId} is invalid: ${invalidReasons.join('; ')}. See ${wdioLog}.`,
            launchError ? { cause: launchError } : undefined
        );
    }

    removeManagedDirectory(appRoot, runtimeRoot);
    return record;
}
