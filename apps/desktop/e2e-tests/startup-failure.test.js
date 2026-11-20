import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileWindowsExecutable, withE2eWebView2Env } from './webview2-env.js';

const STARTUP_TIMEOUT_MS = 15000;
const OUTPUT_CLOSE_TIMEOUT_MS = 2000;
const PROCESS_EXIT_TIMEOUT_MS = 5000;
const CLEANUP_RETRY_COUNT = 40;
const CLEANUP_RETRY_DELAY_MS = 250;
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const descendantFixture = path.join(
    testDirectory,
    'fixtures',
    'startup-failure-with-descendant.cjs'
);
const jobLauncherSource = path.join(testDirectory, 'fixtures', 'windows-job-launcher.cs');
const dialogObserverSource = path.join(testDirectory, 'fixtures', 'windows-dialog-observer.cs');
let jobLauncherPath;
let dialogObserverPath;
let compiledFixtureRoot;

after(async () => {
    if (compiledFixtureRoot) await removeRoot(compiledFixtureRoot);
});

function resolveCompiledFixtureRoot() {
    compiledFixtureRoot ??= mkdtempSync(path.join(os.tmpdir(), 'touchai-startup-job-'));
    return compiledFixtureRoot;
}

function resolveJobLauncher() {
    if (jobLauncherPath) return jobLauncherPath;
    const outputPath = path.join(resolveCompiledFixtureRoot(), 'touchai-startup-job-launcher.exe');
    jobLauncherPath = compileWindowsExecutable(jobLauncherSource, outputPath);
    return jobLauncherPath;
}

function resolveDialogObserver() {
    if (dialogObserverPath) return dialogObserverPath;
    const outputPath = path.join(resolveCompiledFixtureRoot(), 'touchai-dialog-observer.exe');
    dialogObserverPath = compileWindowsExecutable(dialogObserverSource, outputPath);
    return dialogObserverPath;
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeRoot(root) {
    for (let attempt = 1; attempt <= CLEANUP_RETRY_COUNT; attempt += 1) {
        try {
            rmSync(root, { recursive: true, force: true });
            return;
        } catch (error) {
            const retryable = error?.code === 'EBUSY' || error?.code === 'EPERM';
            if (!retryable) {
                throw new Error(`Could not remove startup test root ${root}: ${error}`, {
                    cause: error,
                });
            }
            if (attempt === CLEANUP_RETRY_COUNT) {
                throw new Error(
                    `Could not remove startup test root ${root} after ${CLEANUP_RETRY_COUNT} attempts: ${error}`,
                    { cause: error }
                );
            }
            await delay(CLEANUP_RETRY_DELAY_MS);
        }
    }
}

async function killProcessTree(child) {
    const rootPid = child.pid;
    if (!rootPid) return;

    if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
        await delay(100);
        return;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            process.kill(-rootPid, 'SIGKILL');
        } catch {
            try {
                child.kill('SIGKILL');
            } catch {
                // The process and its group have already exited.
            }
        }
        if (attempt === 0) await delay(50);
    }
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== 'ESRCH';
    }
}

function isZombieProcess(pid) {
    if (process.platform === 'win32') return false;
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
        windowsHide: true,
    });
    return result.status === 0 && result.stdout.trim().startsWith('Z');
}

async function waitForProcessTermination(pid) {
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        // A zombie has released its pipes and files while waiting to be reaped.
        if (!isProcessAlive(pid) || isZombieProcess(pid)) return;
        await delay(100);
    }
    assert.fail(`process ${pid} remained alive after ${PROCESS_EXIT_TIMEOUT_MS}ms`);
}

function waitForOutputToClose(child) {
    const streams = [child.stdout, child.stderr];
    if (streams.every((stream) => stream.closed || stream.destroyed)) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        let remaining = streams.length;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve();
        };
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(
                new Error(
                    `Child output streams remained open for ${OUTPUT_CLOSE_TIMEOUT_MS}ms after cleanup`
                )
            );
        }, OUTPUT_CLOSE_TIMEOUT_MS);
        const finishOne = () => {
            remaining -= 1;
            if (remaining === 0) finish();
        };

        for (const stream of streams) {
            if (stream.closed || stream.destroyed) {
                finishOne();
            } else {
                stream.once('close', finishOne);
            }
        }
    });
}

function runStartupFailure(binary, root, args = [], options = {}) {
    return new Promise((resolve) => {
        const launcher = process.platform === 'win32' ? resolveJobLauncher() : binary;
        const launcherArgs = process.platform === 'win32' ? [binary, ...args] : args;
        const env = withE2eWebView2Env(
            {
                ...process.env,
                TOUCHAI_APP_ROOT: root,
                WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
            },
            { userDataFolder: path.join(root, 'webview2') }
        );
        if (options.interactive) delete env.TOUCHAI_E2E;

        const child = spawn(launcher, launcherArgs, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let spawnError;
        let settled = false;
        let settling = false;
        let timeout;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        function finish(status, signal) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            child.stdout.destroy();
            child.stderr.destroy();
            resolve({ child, status, signal, timedOut, error: spawnError, stdout, stderr });
        }

        async function settle(status, signal) {
            if (settling || settled) return;
            settling = true;
            clearTimeout(timeout);
            try {
                await killProcessTree(child);
                await waitForOutputToClose(child);
            } catch (error) {
                spawnError ??= error;
            }
            finish(status, signal);
        }

        timeout = setTimeout(() => {
            timedOut = true;
            void settle(null, null);
        }, STARTUP_TIMEOUT_MS);

        child.once('error', (error) => {
            spawnError = error;
            if (!child.pid) void settle(null, null);
        });
        child.once('exit', (status, signal) => {
            void settle(status, signal);
        });
        child.once('close', (status, signal) => {
            void settle(status, signal);
        });
    });
}

function runDialogObserver(executable, timeoutMilliseconds) {
    const child = spawn(executable, [String(timeoutMilliseconds)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let error;
    let timedOut = false;
    let settled = false;
    let timeout;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });

    const done = new Promise((resolve) => {
        const finish = (status, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve({ child, status, signal, error, timedOut, stdout, stderr });
        };

        timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
            finish(null, null);
        }, timeoutMilliseconds + 5000);

        child.once('error', (spawnError) => {
            error = spawnError;
            if (!child.pid) finish(null, null);
        });
        child.once('exit', finish);
    });

    return { child, done };
}

test('user gets control back and cleanup succeeds when a failed parent leaves a descendant holding its pipes', async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'touchai-startup-descendant-'));
    const result = await runStartupFailure(process.execPath, root, [descendantFixture]);
    t.after(async () => {
        await killProcessTree(result.child);
        await removeRoot(root);
    });
    const diagnostics = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.error, undefined, diagnostics);
    assert.equal(result.timedOut, false, diagnostics);
    assert.equal(result.signal, null, diagnostics);
    assert.equal(result.status, 17, diagnostics);
    assert.match(diagnostics, /intermediate exiting before its descendant/);
    assert.match(diagnostics, /parent shutting down with a live descendant/);
    assert.match(diagnostics, /descendant is holding stdout and stderr/);
    assert.match(diagnostics, /descendant is holding a profile file/);

    const descendantPid = Number(readFileSync(path.join(root, 'descendant.pid'), 'utf8'));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await waitForProcessTermination(descendantPid);

    await removeRoot(root);
    assert.equal(existsSync(root), false, 'the test root must be removable after cleanup');
});

test('user gets the owning error and a nonzero exit when the database cannot open in E2E mode', async (t) => {
    const binary = process.env.TOUCHAI_STARTUP_TEST_BINARY;
    assert.ok(binary, 'TOUCHAI_STARTUP_TEST_BINARY must point to the built app');

    const root = mkdtempSync(path.join(os.tmpdir(), 'touchai-startup-failure-'));
    const database = path.join(root, 'data', 'touchai.db');
    mkdirSync(database, { recursive: true });

    const result = await runStartupFailure(binary, root);
    t.after(async () => {
        await killProcessTree(result.child);
        await removeRoot(root);
    });
    const diagnostics = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.error, undefined, diagnostics);
    assert.equal(result.timedOut, false, diagnostics);
    assert.equal(result.signal, null, diagnostics);
    assert.notEqual(result.status, null, diagnostics);
    assert.notEqual(result.status, 0, diagnostics);
    assert.match(diagnostics, /Failed to initialize database runtime/);
    assert.match(diagnostics, /Failed to connect sqlite pool/);
    assert.ok(statSync(database).isDirectory(), 'the failing database path must be preserved');
});

test(
    'user sees an interactive startup failure dialog and can close it without leaving the app hung',
    {
        skip: process.platform !== 'win32',
        timeout: 30000,
    },
    async (t) => {
        const binary = process.env.TOUCHAI_STARTUP_TEST_BINARY;
        assert.ok(binary, 'TOUCHAI_STARTUP_TEST_BINARY must point to the built app');

        const root = mkdtempSync(path.join(os.tmpdir(), 'touchai-startup-dialog-'));
        const database = path.join(root, 'data', 'touchai.db');
        mkdirSync(database, { recursive: true });
        const observer = runDialogObserver(resolveDialogObserver(), 12000);
        const result = await runStartupFailure(binary, root, [], { interactive: true });
        const observed = await observer.done;

        t.after(async () => {
            await killProcessTree(observer.child);
            await killProcessTree(result.child);
            await removeRoot(root);
        });
        const diagnostics = `${result.stdout}\n${result.stderr}`;
        const observerDiagnostics = `${observed.stdout}\n${observed.stderr}`;

        assert.equal(result.error, undefined, diagnostics);
        assert.equal(result.timedOut, false, diagnostics);
        assert.equal(result.signal, null, diagnostics);
        assert.notEqual(result.status, null, diagnostics);
        assert.notEqual(result.status, 0, diagnostics);
        assert.match(diagnostics, /Failed to initialize database runtime/);
        assert.match(diagnostics, /Failed to connect sqlite pool/);
        assert.ok(statSync(database).isDirectory(), 'the failing database path must be preserved');

        assert.equal(observed.error, undefined, observerDiagnostics);
        assert.equal(observed.timedOut, false, observerDiagnostics);
        assert.equal(observed.signal, null, observerDiagnostics);
        assert.equal(observed.status, 0, observerDiagnostics);
        assert.match(observed.stdout, /found=true/);
        assert.match(observed.stdout, /class=#32770/);
        assert.match(observed.stdout, /title=TouchAI/);
        assert.match(observed.stdout, /closed=true/);
    }
);
