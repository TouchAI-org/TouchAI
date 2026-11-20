import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { withE2eWebView2Env } from './webview2-env.js';

const STARTUP_TIMEOUT_MS = 15000;

function killProcessTree(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        return;
    }

    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
}

function runStartupFailure(binary, root) {
    return new Promise((resolve) => {
        const child = spawn(binary, [], {
            env: withE2eWebView2Env(
                {
                    ...process.env,
                    TOUCHAI_APP_ROOT: root,
                    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
                },
                { userDataFolder: path.join(root, 'webview2') }
            ),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let spawnError;
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

        function finish(status, signal) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve({ child, status, signal, timedOut, error: spawnError, stdout, stderr });
        }

        timeout = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
            setTimeout(() => finish(null, null), 2000).unref();
        }, STARTUP_TIMEOUT_MS);

        child.once('error', (error) => {
            spawnError = error;
            if (!child.pid) finish(null, null);
        });
        child.once('close', finish);
    });
}

test('user gets the owning error and a nonzero exit when the database cannot open in E2E mode', async (t) => {
    const binary = process.env.TOUCHAI_STARTUP_TEST_BINARY;
    assert.ok(binary, 'TOUCHAI_STARTUP_TEST_BINARY must point to the built app');

    const root = mkdtempSync(path.join(os.tmpdir(), 'touchai-startup-failure-'));
    const database = path.join(root, 'data', 'touchai.db');
    mkdirSync(database, { recursive: true });

    const result = await runStartupFailure(binary, root);
    t.after(() => {
        killProcessTree(result.child);
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
