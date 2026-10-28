// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { LogQueue } from '@services/ObservabilityService/queue';
import type { LogEnvelope } from '@services/ObservabilityService/types';
import { describe, expect, it, vi } from 'vitest';

function envelope(level: LogEnvelope['level'], event: string): LogEnvelope {
    return { level, event, attrs: {} };
}

function queueWith(
    send: (batch: LogEnvelope[]) => Promise<void>,
    capacity: number,
    batchSize = 50
) {
    return new LogQueue({ send, capacity, batchSize });
}

describe('user keeps diagnostics when the log queue is under pressure', () => {
    it('user gets a full batch sent without waiting for the timer', async () => {
        const batches: LogEnvelope[][] = [];
        const queue = queueWith(
            async (batch) => {
                batches.push(batch);
            },
            100,
            2
        );

        queue.push(envelope(3, 'first'));
        queue.push(envelope(3, 'second'));
        await vi.waitFor(() => expect(batches).toHaveLength(1));

        expect(batches[0]?.map((entry) => entry.event)).toEqual(['first', 'second']);
    });

    it('user loses debug lines before warnings when the queue overflows', async () => {
        const batches: LogEnvelope[][] = [];
        const queue = queueWith(
            async (batch) => {
                batches.push(batch);
            },
            2,
            50
        );

        queue.push(envelope(2, 'debug.line'));
        queue.push(envelope(4, 'warn.line'));
        queue.push(envelope(5, 'error.line'));
        await queue.flush();

        const events = batches.flat().map((entry) => entry.event);
        expect(events).toContain('warn.line');
        expect(events).toContain('error.line');
        expect(events).not.toContain('debug.line');
    });

    it('user sees how many lines were dropped in the next batch', async () => {
        const batches: LogEnvelope[][] = [];
        const queue = queueWith(
            async (batch) => {
                batches.push(batch);
            },
            1,
            50
        );

        queue.push(envelope(2, 'debug.line'));
        queue.push(envelope(4, 'warn.line'));
        await queue.flush();

        const [dropped] = batches[0] ?? [];
        expect(dropped?.event).toBe('obs.dropped');
        expect(dropped?.attrs['dropped.debug']).toBe(1);
    });

    it('user keeps the error when a debug flood arrives at a full queue', async () => {
        const batches: LogEnvelope[][] = [];
        const queue = queueWith(
            async (batch) => {
                batches.push(batch);
            },
            1,
            50
        );

        queue.push(envelope(5, 'error.line'));
        queue.push(envelope(2, 'debug.line'));
        await queue.flush();

        const events = batches[0]?.map((item) => item.event) ?? [];
        expect(events).toContain('error.line');
        expect(events).not.toContain('debug.line');
    });

    it('user loses the oldest debug line when a warning arrives at a full queue', async () => {
        const batches: LogEnvelope[][] = [];
        const queue = queueWith(
            async (batch) => {
                batches.push(batch);
            },
            1,
            50
        );

        queue.push(envelope(2, 'debug.line'));
        queue.push(envelope(4, 'warn.line'));
        await queue.flush();

        const events = batches[0]?.map((item) => item.event) ?? [];
        expect(events).toContain('warn.line');
        expect(events).not.toContain('debug.line');
    });

    it('user does not get an exception when the log backend fails', async () => {
        const queue = queueWith(
            async () => {
                throw new Error('backend down');
            },
            10,
            50
        );

        queue.push(envelope(3, 'event'));
        await expect(queue.flush()).resolves.toBeUndefined();
    });
});
