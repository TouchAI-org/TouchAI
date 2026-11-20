// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    aggregateMemory,
    processBelongsToRun,
    readRollup,
} from '../../../scripts/perf/710/process-memory.mjs';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('user reads RFC 710 process memory samples', () => {
    it('user sees unavailable PSS kept unavailable instead of being treated as zero', () => {
        expect(
            aggregateMemory([
                { pssKb: 100, rssKb: 120, privateDirtyKb: 80 },
                { pssKb: null, rssKb: 200, privateDirtyKb: null },
            ])
        ).toEqual({
            totalPssKb: null,
            totalRssKb: 320,
            totalPrivateDirtyKb: null,
        });
    });

    it('user keeps RSS when only process status is readable', () => {
        vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor) => {
            if (String(file).endsWith('/smaps_rollup')) {
                throw new Error('permission denied');
            }
            if (String(file).endsWith('/status')) {
                return 'Name:\tTouchAI\nVmRSS:\t  12345 kB\n';
            }
            throw new Error(`Unexpected file: ${String(file)}`);
        }) as typeof fs.readFileSync);

        expect(readRollup(42)).toEqual({
            pssKb: null,
            rssKb: 12345,
            privateDirtyKb: null,
        });
    });

    it('user excludes a same-cgroup process that lacks the current run identity', () => {
        const identity = {
            appPids: new Set([100]),
            appCgroups: new Set(['/run/user/1000/touchai-test.scope']),
            environmentMarker: 'TOUCHAI_APP_ROOT=/tmp/run-a',
            runTokenMarker: 'TOUCHAI_PERF_RUN_TOKEN=run-a',
        };

        expect(
            processBelongsToRun(
                {
                    pid: 200,
                    cgroup: '/run/user/1000/touchai-test.scope',
                    environment: [],
                },
                identity
            )
        ).toBe(false);
        expect(
            processBelongsToRun(
                {
                    pid: 201,
                    cgroup: '/run/user/1000/touchai-test.scope',
                    environment: ['TOUCHAI_PERF_RUN_TOKEN=run-a'],
                },
                identity
            )
        ).toBe(true);
    });
});
