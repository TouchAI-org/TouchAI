// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import { MANIFEST_VERSION } from '../../../scripts/perf/lib/config.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(directory, '../../../scripts/perf/run.mjs');
const lockModule = pathToFileURL(
    path.resolve(directory, '../../../scripts/perf/lib/lock.mjs')
).href;

function killIfAlive(pid) {
    try {
        process.kill(pid, 'SIGKILL');
    } catch (error) {
        if (error.code !== 'ESRCH') throw error;
    }
}

it.skipIf(process.platform !== 'linux').each([
    ['build', 'SIGTERM'],
    ['build', 'SIGINT'],
    ['run', 'SIGTERM'],
    ['run', 'SIGINT'],
])(
    'user cancels %s with %s and gets no surviving workload before the lock is released',
    async (command, signal) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-cancel-'));
        const worker = path.join(root, 'worker.cjs');
        const evidenceRoot = path.join(root, 'evidence');
        const artifactsRoot = path.join(root, 'artifacts');
        const pids = path.join(root, 'pids');
        fs.writeFileSync(
            worker,
            `
        const fs = require('node:fs');
        const { spawn } = require('node:child_process');
        if (!process.argv[2]) spawn(process.execPath, [__filename, 'leaf'], { stdio: 'ignore', detached: true });
        fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
    `
        );
        const snapshot = path.join(artifactsRoot, 'snapshots/baseline');
        const shim = path.join(snapshot, 'apps/desktop/node_modules/.bin/tauri');
        fs.mkdirSync(path.dirname(shim), { recursive: true });
        fs.mkdirSync(evidenceRoot);
        fs.writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${worker}'\n`, {
            mode: 0o755,
        });
        const comparison = { baselineCommit: 'a'.repeat(40), candidateCommit: 'b'.repeat(40) };
        const source = JSON.stringify({
            version: MANIFEST_VERSION,
            arm: 'baseline',
            snapshot,
            comparison,
            entries: [],
        });
        fs.writeFileSync(path.join(evidenceRoot, 'baseline.json'), source);
        fs.writeFileSync(
            path.join(evidenceRoot, 'source-manifest.json'),
            JSON.stringify({
                version: MANIFEST_VERSION,
                comparison,
                baseline: {
                    path: 'baseline.json',
                    sha256: createHash('sha256').update(source).digest('hex'),
                },
            })
        );
        let entrypoint = cli;
        let port = 3426;
        if (command === 'run') {
            // Replace only the native display/driver boundary with a harmless workload.
            const checkout = path.join(root, 'checkout');
            const scripts = path.join(checkout, 'apps/desktop/scripts/perf');
            fs.cpSync(path.dirname(cli), scripts, { recursive: true });
            fs.symlinkSync(
                path.resolve(directory, '../../../node_modules'),
                path.join(checkout, 'node_modules')
            );
            fs.mkdirSync(path.join(checkout, 'apps/desktop/e2e-tests'), { recursive: true });
            fs.writeFileSync(
                path.join(scripts, 'xvfb-run-with-wm.sh'),
                `#!/bin/sh\nexec '${process.execPath}' '${worker}'\n`,
                { mode: 0o755 }
            );
            entrypoint = path.join(scripts, 'run.mjs');
            const listener = net.createServer();
            await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
            port = listener.address().port;
            await new Promise((resolve) => listener.close(resolve));
            const builds = ['baseline', 'current'].map((arm) => {
                for (const [relative, content] of [
                    [`binaries/${arm}/TouchAI`, 'binary'],
                    [`fixtures/${arm}/fixture-base.db`, 'fixture'],
                ]) {
                    const file = path.join(evidenceRoot, relative);
                    fs.mkdirSync(path.dirname(file), { recursive: true });
                    fs.writeFileSync(file, content);
                }
                return {
                    arm,
                    comparison,
                    binarySha256: createHash('sha256').update('binary').digest('hex'),
                    sourceManifestSha256: 'source',
                };
            });
            fs.writeFileSync(path.join(evidenceRoot, 'builds.json'), JSON.stringify({ builds }));
            fs.writeFileSync(
                path.join(evidenceRoot, 'source-manifest.json'),
                JSON.stringify({
                    comparison,
                    baseline: { sha256: 'source' },
                    current: { sha256: 'source' },
                })
            );
            fs.writeFileSync(
                path.join(evidenceRoot, 'fixture-manifest.json'),
                JSON.stringify({
                    version: MANIFEST_VERSION,
                    comparison,
                    modelEndpoint: `http://127.0.0.1:${port}/v1`,
                })
            );
        }
        const child = spawn(
            process.execPath,
            [
                entrypoint,
                command,
                '--flows',
                'latency',
                '--latency-blocks',
                '1',
                '--warm-samples',
                '0',
            ],
            {
                env: {
                    ...process.env,
                    TOUCHAI_PERF_EVIDENCE: evidenceRoot,
                    TOUCHAI_PERF_ARTIFACTS: artifactsRoot,
                    TOUCHAI_PERF_DISABLE_CGROUP: '1',
                    TOUCHAI_PERF_PORT: String(port),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );
        let errors = '';
        child.stderr.on('data', (data) => {
            errors += data;
        });
        const live = (pid) => {
            try {
                return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z');
            } catch {
                return false;
            }
        };
        const readPids = () =>
            fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number) : [];
        try {
            await expect.poll(() => errors || readPids().length, { timeout: 5000 }).toBe(2);
            child.kill(signal);
            await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(1);
            expect(readPids().some(live)).toBe(false);
            const { acquirePerformanceHarnessLock } = await import(lockModule);
            const next = acquirePerformanceHarnessLock({
                command: 'stats',
                evidenceRoot: path.join(root, 'evidence'),
                artifactsRoot: path.join(root, 'artifacts'),
            });
            next.release();
            if (command === 'build') {
                expect(
                    fs.readFileSync(path.join(evidenceRoot, 'logs/build-baseline.log'), 'utf8')
                ).toContain('SIGTERM');
                expect(
                    fs.readFileSync(path.join(evidenceRoot, 'logs/runner-error.log'), 'utf8')
                ).toContain('cancelled');
            } else {
                const records = fs
                    .readFileSync(path.join(evidenceRoot, 'raw/formal/runs.jsonl'), 'utf8')
                    .trim()
                    .split('\n')
                    .map((line) => JSON.parse(line));
                expect(records.map((record) => record.type)).toEqual(['run-launch', 'run']);
                expect(records[1]).toMatchObject({
                    valid: false,
                    signal: 'SIGTERM',
                    attempt: 1,
                    runId: records[0].runId,
                    binarySha256: records[0].binarySha256,
                    fixtureSha256: records[0].fixtureSha256,
                });
                const samplerStillRunning = fs
                    .readdirSync('/proc')
                    .filter((pid) => /^\d+$/.test(pid))
                    .some((pid) => {
                        try {
                            return fs
                                .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
                                .includes(
                                    path.join(
                                        root,
                                        'checkout/apps/desktop/scripts/perf/process-memory.mjs'
                                    )
                                );
                        } catch (error) {
                            if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
                            throw error;
                        }
                    });
                expect(samplerStillRunning).toBe(false);
                await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
            }
        } finally {
            for (const pid of readPids()) {
                killIfAlive(pid);
            }
            if (child.exitCode === null && child.signalCode === null) {
                const exited = new Promise((resolve) => child.once('exit', resolve));
                child.kill('SIGKILL');
                await exited;
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    },
    20000
);
