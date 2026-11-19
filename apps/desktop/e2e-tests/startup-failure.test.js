import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { withE2eWebView2Env } from './webview2-env.js';

test('user gets the owning error and a nonzero exit when the database cannot open in E2E mode', (t) => {
    const binary = process.env.TOUCHAI_STARTUP_TEST_BINARY;
    assert.ok(binary, 'TOUCHAI_STARTUP_TEST_BINARY must point to the built app');

    const root = mkdtempSync(path.join(os.tmpdir(), 'touchai-startup-failure-'));
    const database = path.join(root, 'data', 'touchai.db');
    mkdirSync(database, { recursive: true });
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

    const result = spawnSync(binary, [], {
        env: withE2eWebView2Env(
            {
                ...process.env,
                TOUCHAI_APP_ROOT: root,
                WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
            },
            { userDataFolder: path.join(root, 'webview2') }
        ),
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
    });
    const diagnostics = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    assert.equal(result.error, undefined, diagnostics);
    assert.equal(result.signal, null, diagnostics);
    assert.notEqual(result.status, null, diagnostics);
    assert.notEqual(result.status, 0, diagnostics);
    assert.match(diagnostics, /Failed to initialize database runtime/);
    assert.match(diagnostics, /Failed to connect sqlite pool/);
    assert.ok(statSync(database).isDirectory(), 'the failing database path must be preserved');
});
