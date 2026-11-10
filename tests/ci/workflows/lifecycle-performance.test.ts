import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporaryRoot = resolve(tmpdir());
const directories: string[] = [];
const cases = ['menu', 'model', 'confirm', 'import'];

function fixture(
    options: {
        headLatency?: number;
        headMemory?: number;
        headDpr?: number;
        headSessions?: number;
    } = {}
) {
    const directory = mkdtempSync(join(temporaryRoot, 'touchai-native-performance-'));
    directories.push(directory);
    for (const variant of ['baseline', 'head']) {
        for (
            let block = 0;
            block < (variant === 'head' ? (options.headSessions ?? 6) : 6);
            block += 1
        ) {
            const latency = variant === 'head' ? (options.headLatency ?? 100) : 100;
            const memory = variant === 'head' ? (options.headMemory ?? 1000) : 1000;
            writeFileSync(
                join(directory, `sample-${block}-${variant}.json`),
                JSON.stringify({
                    variant,
                    block,
                    commit: variant,
                    cases: Object.fromEntries(
                        cases.map((name) => [
                            name,
                            {
                                openMs: Array.from({ length: 50 }, () => latency),
                                closeMs: Array.from({ length: 50 }, () => latency),
                                dom: 100,
                                longTasks: [],
                                environment: {
                                    userAgent: 'fixed-webview',
                                    dpr: variant === 'head' ? (options.headDpr ?? 1) : 1,
                                    width: 750,
                                    height: 1080,
                                    visibility: 'visible',
                                    reducedMotion: false,
                                },
                            },
                        ])
                    ),
                    memory: Array.from({ length: 5 }, () => ({
                        privateBytes: memory,
                        workingSetBytes: memory,
                        processes: 5,
                        renderers: 2,
                    })),
                })
            );
        }
    }
    return directory;
}

function compare(directory: string) {
    return spawnSync(
        process.execPath,
        [join(root, 'apps/desktop/e2e-tests/performance/compare.mjs'), directory],
        {
            encoding: 'utf8',
            windowsHide: true,
        }
    );
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        if (dirname(resolve(directory)) !== temporaryRoot)
            throw new Error('Unsafe temporary directory');
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('user receives native release acceptance evidence', () => {
    it('user stays at the five percent latency limit and the full paired report passes', () => {
        const directory = fixture({ headLatency: 105 });
        expect(compare(directory).status).toBe(0);
        expect(JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'))).toMatchObject({
            passed: true,
            samplesPerPhase: 300,
            sessionsPerRevision: 6,
        });
    });

    it('user exceeds the latency budget and acceptance fails while preserving the report', () => {
        const directory = fixture({ headLatency: 106 });
        expect(compare(directory).status).toBe(1);
        expect(readFileSync(join(directory, 'summary.md'), 'utf8')).toContain('Acceptance failed');
    });

    it('user retains too much native process memory and acceptance fails', () => {
        expect(compare(fixture({ headMemory: 1051 })).status).toBe(1);
    });

    it('user changes DPI between revisions and the comparison is rejected instead of normalized', () => {
        const result = compare(fixture({ headDpr: 2 }));
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('same WebView, DPI and viewport');
    });

    it('user supplies incomplete native sessions and cannot receive a passing report', () => {
        const result = compare(fixture({ headSessions: 5 }));
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('six independent native sessions');
    });
});
