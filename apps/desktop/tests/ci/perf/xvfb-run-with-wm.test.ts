// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.resolve(testDirectory, '../../../scripts/perf/xvfb-run-with-wm.sh');
const requiredCommands = [
    'xvfb-run',
    'dbus-run-session',
    'dbus-send',
    'dunst',
    'openbox',
    'wmctrl',
];
const hasDisplayStack =
    process.platform === 'linux' &&
    requiredCommands.every((command) => spawnSync('which', [command]).status === 0);

let root: string | null = null;

afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
});

describe('user runs the performance workload inside a display session', () => {
    it.skipIf(!hasDisplayStack)(
        'user keeps a configured run-log directory after the display wrapper exits',
        () => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-display-'));
            const logDirectory = path.join(root, 'configured-logs');
            const result = spawnSync(
                wrapper,
                ['bash', '-c', 'printf ready > "$TOUCHAI_PERF_RUN_LOG_DIR/probe"'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        TOUCHAI_PERF_RUN_LOG_DIR: logDirectory,
                    },
                    timeout: 30000,
                }
            );

            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr).toBe(0);
            expect(fs.readFileSync(path.join(logDirectory, 'probe'), 'utf8')).toBe('ready');
            expect(fs.existsSync(path.join(logDirectory, 'openbox.log'))).toBe(true);
            expect(fs.existsSync(path.join(logDirectory, 'dunst.log'))).toBe(true);
        }
    );
});
