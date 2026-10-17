import { describe, expect, it } from 'vitest';

import {
    clampTimeoutMs,
    parseRequestedTimeoutMs,
    resolveAdaptiveTimeoutCeilingMs,
    TOOL_TIMEOUT_MAX_MS,
    TOOL_TIMEOUT_MIN_MS,
} from '@/utils/timeouts';

describe('clampTimeoutMs', () => {
    it('returns the fallback when no timeout is requested', () => {
        expect(clampTimeoutMs(undefined, 15000)).toBe(15000);
        expect(clampTimeoutMs(null, 15000)).toBe(15000);
    });

    it('returns the fallback for non-integer or non-finite values', () => {
        expect(clampTimeoutMs(1500.5, 30000)).toBe(30000);
        expect(clampTimeoutMs(Number.NaN, 30000)).toBe(30000);
        expect(clampTimeoutMs(Number.POSITIVE_INFINITY, 30000)).toBe(30000);
    });

    it('keeps a requested value inside the default bounds', () => {
        expect(clampTimeoutMs(60000, 30000)).toBe(60000);
    });

    it('falls back to the configured value for requests below the minimum', () => {
        // 0 / 负数常被模型用来表达“不限时”，抬到 1 秒会把长任务直接杀掉。
        expect(clampTimeoutMs(0, 30000)).toBe(30000);
        expect(clampTimeoutMs(1, 30000)).toBe(30000);
        expect(clampTimeoutMs(-5000, 30000)).toBe(30000);
        expect(clampTimeoutMs(TOOL_TIMEOUT_MIN_MS - 1, 30000)).toBe(30000);
    });

    it('caps values above the default maximum', () => {
        expect(clampTimeoutMs(TOOL_TIMEOUT_MAX_MS + 1, 30000)).toBe(TOOL_TIMEOUT_MAX_MS);
    });

    it('honors a tighter tool-specific ceiling', () => {
        expect(clampTimeoutMs(600000, 15000, 120000)).toBe(120000);
        expect(clampTimeoutMs(45000, 15000, 120000)).toBe(45000);
    });
});

describe('parseRequestedTimeoutMs', () => {
    it('returns the original arguments object when no metadata is present', () => {
        const toolArgs = { command: 'dir' };
        const parsed = parseRequestedTimeoutMs(toolArgs);

        expect(parsed.requestedTimeoutMs).toBeUndefined();
        expect(parsed.sanitizedToolArgs).toBe(toolArgs);
    });

    it('extracts an integer timeout and strips the reserved key', () => {
        const parsed = parseRequestedTimeoutMs({ command: 'dir', _meta: { timeoutMs: 45000 } });

        expect(parsed.requestedTimeoutMs).toBe(45000);
        expect(parsed.sanitizedToolArgs).toEqual({ command: 'dir' });
        expect(parsed.sanitizedToolArgs).not.toHaveProperty('_meta');
    });

    it('does not mutate the original arguments object', () => {
        const toolArgs = { command: 'dir', _meta: { timeoutMs: 45000 } };
        parseRequestedTimeoutMs(toolArgs);

        expect(toolArgs).toHaveProperty('_meta');
    });

    it('strips malformed metadata without adopting a timeout', () => {
        for (const meta of [null, 'slow', 42, [], { timeoutMs: '60000' }, { timeoutMs: 1.5 }]) {
            const parsed = parseRequestedTimeoutMs({ command: 'dir', _meta: meta });

            expect(parsed.requestedTimeoutMs).toBeUndefined();
            expect(parsed.sanitizedToolArgs).not.toHaveProperty('_meta');
        }
    });

    it('ignores non-integer timeouts but still removes the reserved key', () => {
        const parsed = parseRequestedTimeoutMs({ _meta: { timeoutMs: 1000.25 } });

        expect(parsed.requestedTimeoutMs).toBeUndefined();
        expect(parsed.sanitizedToolArgs).toEqual({});
    });
});

describe('resolveAdaptiveTimeoutCeilingMs', () => {
    it('returns the configured timeout when it can form a valid range', () => {
        expect(resolveAdaptiveTimeoutCeilingMs(TOOL_TIMEOUT_MIN_MS)).toBe(TOOL_TIMEOUT_MIN_MS);
        expect(resolveAdaptiveTimeoutCeilingMs(30000)).toBe(30000);
        expect(resolveAdaptiveTimeoutCeilingMs(TOOL_TIMEOUT_MAX_MS * 2)).toBe(
            TOOL_TIMEOUT_MAX_MS * 2
        );
    });

    it('returns undefined when the user disabled the timeout', () => {
        expect(resolveAdaptiveTimeoutCeilingMs(0)).toBeUndefined();
        expect(resolveAdaptiveTimeoutCeilingMs(-1)).toBeUndefined();
    });

    it('returns undefined when the configured timeout leaves no valid range', () => {
        expect(resolveAdaptiveTimeoutCeilingMs(TOOL_TIMEOUT_MIN_MS - 1)).toBeUndefined();
    });

    it('returns undefined for values that are not safe integers', () => {
        expect(resolveAdaptiveTimeoutCeilingMs(1500.5)).toBeUndefined();
        expect(resolveAdaptiveTimeoutCeilingMs(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
        expect(resolveAdaptiveTimeoutCeilingMs(1e20)).toBeUndefined();
        expect(resolveAdaptiveTimeoutCeilingMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    });
});
