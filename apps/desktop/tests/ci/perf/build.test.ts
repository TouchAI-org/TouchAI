// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runInCgroup, verifyPreparedSnapshot } = vi.hoisted(() => ({
    runInCgroup: vi.fn(),
    verifyPreparedSnapshot: vi.fn(),
}));

vi.mock('../../../scripts/perf/lib/process.mjs', () => ({ runInCgroup }));
vi.mock('../../../scripts/perf/lib/snapshots.mjs', () => ({ verifyPreparedSnapshot }));

let root: string | null = null;

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function prepareBuildInputs(comparison: { baselineCommit: string; candidateCommit: string }): {
    artifacts: string;
    evidence: string;
} {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-build-'));
    const evidence = path.join(root, 'evidence');
    const artifacts = path.join(root, 'artifacts');
    for (const arm of ['baseline', 'current']) {
        const tauri = path.join(artifacts, `snapshots/${arm}/apps/desktop/node_modules/.bin/tauri`);
        fs.mkdirSync(path.dirname(tauri), { recursive: true });
        fs.writeFileSync(tauri, 'tauri');
    }
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(
        path.join(evidence, 'source-manifest.json'),
        JSON.stringify({
            version: 3,
            comparison,
            baseline: { path: 'baseline.json', sha256: 'baseline-source' },
            current: { path: 'current.json', sha256: 'current-source' },
        })
    );
    process.env.TOUCHAI_PERF_ARTIFACTS = artifacts;
    process.env.TOUCHAI_PERF_EVIDENCE = evidence;
    return { artifacts, evidence };
}

beforeEach(() => {
    vi.resetModules();
    runInCgroup.mockReset();
    verifyPreparedSnapshot.mockReset();
    runInCgroup.mockImplementation(async ({ log }: { log: string }) => {
        const release = path.join(process.env.TOUCHAI_PERF_ARTIFACTS!, 'target/release');
        fs.mkdirSync(release, { recursive: true });
        fs.writeFileSync(path.join(release, 'TouchAI'), 'release binary');
        fs.mkdirSync(path.dirname(log), { recursive: true });
        fs.writeFileSync(log, 'release build log\n');
        return {
            command: 'tauri build --no-bundle',
            cwd: process.cwd(),
            exitCode: 0,
            signal: null,
            elapsedMs: 42,
            log,
        };
    });
});

afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
    delete process.env.TOUCHAI_PERF_ARTIFACTS;
    delete process.env.TOUCHAI_PERF_EVIDENCE;
});

describe('user builds comparable performance arms', () => {
    it('user builds an A/A comparison once and reuses it for both arms', async () => {
        const commit = 'a'.repeat(40);
        const { evidence } = prepareBuildInputs({
            baselineCommit: commit,
            candidateCommit: commit,
        });

        const { buildBoth } = await import('../../../scripts/perf/lib/build.mjs');
        const results = await buildBoth();

        expect(runInCgroup).toHaveBeenCalledTimes(1);
        expect(verifyPreparedSnapshot).toHaveBeenCalledWith(
            'baseline',
            path.join(root!, 'artifacts/snapshots/baseline')
        );
        expect(verifyPreparedSnapshot).toHaveBeenCalledWith(
            'current',
            path.join(root!, 'artifacts/snapshots/current')
        );
        expect(results).toHaveLength(2);
        expect(results[1]).toMatchObject({
            arm: 'current',
            elapsedMs: 0,
            reusedFrom: 'baseline',
            sourceManifestSha256: 'current-source',
        });
        expect(fs.readFileSync(path.join(evidence, 'binaries/current/TouchAI'), 'utf8')).toBe(
            fs.readFileSync(path.join(evidence, 'binaries/baseline/TouchAI'), 'utf8')
        );
        expect(results[1]!.binarySha256).toBe(results[0]!.binarySha256);
        expect(JSON.parse(fs.readFileSync(path.join(evidence, 'builds.json'), 'utf8'))).toEqual({
            generatedAt: expect.any(String),
            builds: results,
        });
    });

    it('user builds both arms when their commits differ', async () => {
        const { evidence } = prepareBuildInputs({
            baselineCommit: 'a'.repeat(40),
            candidateCommit: 'b'.repeat(40),
        });

        const { buildBoth } = await import('../../../scripts/perf/lib/build.mjs');
        const results = await buildBoth();

        expect(runInCgroup).toHaveBeenCalledTimes(2);
        expect(results.map((result) => result.arm)).toEqual(['baseline', 'current']);
        expect(results[0]!.binarySha256).toBe(sha256('release binary'));
        expect(results[1]!.binarySha256).toBe(sha256('release binary'));
        expect(results[1]!.reusedFrom).toBeUndefined();
        expect(fs.readFileSync(path.join(evidence, 'logs/build-current.log'), 'utf8')).toBe(
            'release build log\n'
        );
    });
});
