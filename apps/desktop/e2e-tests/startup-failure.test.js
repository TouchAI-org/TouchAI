import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { withE2eWebView2Env } from './webview2-env.js';

const STARTUP_TIMEOUT_MS = 15000;
const OUTPUT_CLOSE_TIMEOUT_MS = 2000;
const CLEANUP_RETRY_COUNT = 40;
const CLEANUP_RETRY_DELAY_MS = 250;
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const descendantFixture = path.join(
    testDirectory,
    'fixtures',
    'startup-failure-with-descendant.cjs'
);

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
                throw new Error(`Could not remove startup test root ${root}: ${error}`);
            }
            if (attempt === CLEANUP_RETRY_COUNT) {
                throw new Error(
                    `Could not remove startup test root ${root} after ${CLEANUP_RETRY_COUNT} attempts: ${error}`
                );
            }
            await delay(CLEANUP_RETRY_DELAY_MS);
        }
    }
}

function listWindowsDescendantPids(rootPid) {
    const result = spawnSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }',
        ],
        {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
        }
    );
    if (result.status !== 0 || !result.stdout) return [];

    const childrenByParent = new Map();
    for (const line of result.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [processId, parentProcessId] = trimmed.split(',').map((value) => Number(value));
        if (!Number.isInteger(processId) || !Number.isInteger(parentProcessId)) continue;
        const children = childrenByParent.get(parentProcessId) ?? [];
        children.push(processId);
        childrenByParent.set(parentProcessId, children);
    }

    const descendants = [];
    const pending = [...(childrenByParent.get(rootPid) ?? [])];
    while (pending.length > 0) {
        const processId = pending.shift();
        descendants.push(processId);
        pending.push(...(childrenByParent.get(processId) ?? []));
    }
    return descendants;
}

function killWindowsPid(processId) {
    spawnSync('taskkill', ['/pid', String(processId), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
    });
}

async function killProcessTree(child) {
    const rootPid = child.pid;
    if (!rootPid) return;

    if (process.platform === 'win32') {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (child.exitCode === null && child.signalCode === null) {
                killWindowsPid(rootPid);
            }
            for (const processId of listWindowsDescendantPids(rootPid)) {
                killWindowsPid(processId);
            }
            if (attempt === 0) await delay(100);
        }
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

function waitForOutputToClose(child) {
    const streams = [child.stdout, child.stderr];
    if (streams.every((stream) => stream.closed || stream.destroyed)) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let remaining = streams.length;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve();
        };
        const finishOne = () => {
            remaining -= 1;
            if (remaining === 0) finish();
        };
        const timeout = setTimeout(finish, OUTPUT_CLOSE_TIMEOUT_MS);

        for (const stream of streams) {
            if (stream.closed || stream.destroyed) {
                finishOne();
            } else {
                stream.once('close', finishOne);
            }
        }
    });
}

function runStartupFailure(binary, root, args = []) {
    return new Promise((resolve) => {
        const child = spawn(binary, args, {
            env: withE2eWebView2Env(
                {
                    ...process.env,
                    TOUCHAI_APP_ROOT: root,
                    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
                },
                { userDataFolder: path.join(root, 'webview2') }
            ),
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
            await killProcessTree(child);
            await waitForOutputToClose(child);
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
    assert.match(diagnostics, /parent shutting down with a live descendant/);
    assert.match(diagnostics, /descendant is holding stdout and stderr/);
    assert.match(diagnostics, /descendant is holding a locked profile file/);

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
