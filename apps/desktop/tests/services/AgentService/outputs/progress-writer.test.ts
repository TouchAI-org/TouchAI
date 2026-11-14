import { describe, expect, it, vi } from 'vitest';

import type { PersistedOutputPart } from '@/services/AgentService/contracts/protocol';
import {
    LatestProgressWriter,
    type ProgressWrite,
} from '@/services/AgentService/outputs/progressWriter';

function text(content: string): PersistedOutputPart[] {
    return [{ type: 'text', content }];
}

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolveFn, rejectFn) => {
        resolve = resolveFn;
        reject = rejectFn;
    });
    return { promise, resolve, reject };
}

function target(attemptToken = 'attempt-1', attemptGeneration = 1) {
    return { taskId: 'task-1', attemptToken, attemptGeneration, step: 0 };
}

function contentOf(write: ProgressWrite): string {
    return (write.parts[0] as { content: string }).content;
}

describe('user streams progress snapshots while an attempt is running', () => {
    it('user only ever has one write in flight and one latest pending', async () => {
        const gate = deferred();
        const persisted: string[] = [];
        const persist = vi.fn(async (write: ProgressWrite) => {
            await gate.promise;
            persisted.push(contentOf(write));
        });

        const writer = new LatestProgressWriter(target(), persist);

        writer.enqueue(text('a'));
        writer.enqueue(text('b'));
        writer.enqueue(text('c'));
        writer.enqueue(text('d'));

        // Only the first write started; everything else collapsed into one pending.
        expect(persist).toHaveBeenCalledTimes(1);

        gate.resolve();
        await writer.drain();

        // The in-flight snapshot plus the latest pending snapshot; b/c were superseded.
        expect(persisted).toEqual(['a', 'd']);
    });

    it('user sees the latest snapshot persisted even under rapid updates', async () => {
        const persisted: string[] = [];
        const persist = async (write: ProgressWrite) => {
            persisted.push(contentOf(write));
        };
        const writer = new LatestProgressWriter(target(), persist);

        for (const value of ['a', 'b', 'c']) {
            writer.enqueue(text(value));
        }
        await writer.drain();

        expect(persisted[persisted.length - 1]).toBe('c');
    });

    it('user does not re-persist an unchanged snapshot', async () => {
        const persist = vi.fn(async () => undefined);
        const writer = new LatestProgressWriter(target(), persist);

        writer.enqueue(text('a'));
        writer.enqueue(text('a'));
        await writer.drain();

        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('user keeps streaming after a persistence error', async () => {
        const onError = vi.fn();
        const persisted: string[] = [];
        let calls = 0;
        const persist = async (write: ProgressWrite) => {
            calls += 1;
            if (calls === 1) {
                throw new Error('database is locked');
            }
            persisted.push(contentOf(write));
        };
        const writer = new LatestProgressWriter(target(), persist, onError);

        writer.enqueue(text('a'));
        await writer.drain();
        writer.enqueue(text('b'));
        await writer.drain();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(persisted).toEqual(['b']);
    });

    it('user progress is not written for an attempt that already closed', async () => {
        const persist = vi.fn(async () => undefined);
        const writer = new LatestProgressWriter(target(), persist);

        writer.close();
        writer.enqueue(text('late'));
        await writer.drain();

        expect(persist).not.toHaveBeenCalled();
    });

    it('user sees the superseded snapshot dropped when the step closes mid-flight', async () => {
        const gate = deferred();
        const persisted: string[] = [];
        const persist = async (write: ProgressWrite) => {
            await gate.promise;
            persisted.push(contentOf(write));
        };
        const writer = new LatestProgressWriter(target(), persist);

        writer.enqueue(text('a')); // in flight
        writer.enqueue(text('b')); // superseded pending
        writer.close(); // step boundary: drop pending, keep the in-flight write
        gate.resolve();
        await writer.drain();

        expect(persisted).toEqual(['a']);
    });
});
