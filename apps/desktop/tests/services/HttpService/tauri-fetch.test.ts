import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Tauri HTTP plugin streams a response body from a native resource. The
 * wrapper has to hand that body to the AI SDK without buffering the whole
 * response eagerly, and a downstream cancel has to reach the native reader so
 * the request is actually stopped. The plugin rejects a second cancel after the
 * resource was released, so the wrapper must tolerate that too.
 */
const pluginFetch = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: pluginFetch }));

const { createTauriFetch } = await import('@/services/HttpService');

interface ControlledSource {
    stream: ReadableStream<Uint8Array>;
    pulls: () => number;
    cancelReasons: unknown[];
    readerCancelReasons: unknown[];
    releasePull: () => void;
}

function createSource(
    chunkCount: number,
    options: {
        cancelRejects?: boolean;
        highWaterMark?: number;
        errorAtChunk?: number;
        holdPull?: boolean;
    } = {}
): ControlledSource {
    let pulls = 0;
    let index = 0;
    const cancelReasons: unknown[] = [];
    const readerCancelReasons: unknown[] = [];
    const pullResolvers: Array<() => void> = [];
    const chunks = Array.from({ length: chunkCount }, (_, i) =>
        new TextEncoder().encode(`chunk-${i}`)
    );

    const stream = new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                pulls += 1;
                if (options.holdPull) {
                    await new Promise<void>((resolve) => pullResolvers.push(resolve));
                }
                if (options.errorAtChunk === index) {
                    throw new Error('upstream read failed');
                }
                const chunk = chunks[index];
                if (chunk === undefined) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk);
                index += 1;
            },
            async cancel(reason) {
                cancelReasons.push(reason);
                if (options.cancelRejects) {
                    throw new Error('The resource id 42 is invalid');
                }
            },
        },
        new CountQueuingStrategy({ highWaterMark: options.highWaterMark ?? 1 })
    );

    return {
        stream,
        pulls: () => pulls,
        cancelReasons,
        readerCancelReasons,
        releasePull: () => pullResolvers.shift()?.(),
    };
}

async function openResponse(source: ControlledSource): Promise<Response> {
    const upstream = new Response(source.stream, { status: 200 });
    const body = upstream.body!;
    const getReader = body.getReader.bind(body);
    body.getReader = ((...args: Parameters<typeof getReader>) => {
        const reader = getReader(...args);
        const cancel = reader.cancel.bind(reader);
        reader.cancel = ((reason?: unknown) => {
            source.readerCancelReasons.push(reason);
            return cancel(reason);
        }) as typeof reader.cancel;
        return reader;
    }) as typeof body.getReader;
    pluginFetch.mockResolvedValue(upstream);
    return createTauriFetch()('https://example.com/stream', { method: 'POST' });
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('user streams a response through the Tauri HTTP plugin', () => {
    beforeEach(() => {
        pluginFetch.mockReset();
    });

    it('user receives every upstream chunk in order', async () => {
        const source = createSource(4);
        const response = await openResponse(source);

        const received: string[] = [];
        const reader = response.body!.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received.push(new TextDecoder().decode(value));
        }

        expect(received).toEqual(['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3']);
    });

    it('user does not have the response eagerly drained while reading slowly', async () => {
        // highWaterMark 0 removes the source's own prefetch, so the pulls observed
        // here are driven by the wrapper alone (HWM 1 would add one more).
        const source = createSource(6, { highWaterMark: 0 });
        const response = await openResponse(source);

        await settle();

        expect(response.body).not.toBeNull();
        // An unwrapped response would still be at zero here. Exactly one pull proves the
        // wrapper forwards downstream demand instead of eagerly draining the upstream.
        expect(source.pulls()).toBe(1);

        const reader = response.body!.getReader();
        await reader.read();
        await settle();
        const pullsAfterOneRead = source.pulls();
        expect(pullsAfterOneRead).toBe(2);

        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(source.pulls()).toBe(pullsAfterOneRead);
        expect(source.pulls()).toBeLessThan(6);
    });

    it('user cancelling the response stops the upstream request', async () => {
        const source = createSource(6);
        const response = await openResponse(source);

        await response.body!.cancel('user-cancelled');

        expect(source.cancelReasons).toEqual(['user-cancelled']);
    });

    it('user cancelling twice does not surface the already-released upstream error', async () => {
        const source = createSource(6, { cancelRejects: true });
        const response = await openResponse(source);

        await expect(response.body!.cancel('first')).resolves.toBeUndefined();
        await expect(response.body!.cancel('second')).resolves.toBeUndefined();

        expect(source.cancelReasons).toEqual(['first']);
    });

    it('user cancelling while an upstream read is in flight still stops the request', async () => {
        const source = createSource(2, { holdPull: true });
        const response = await openResponse(source);
        const reader = response.body!.getReader();
        const pendingRead = reader.read();
        await settle();
        expect(source.pulls()).toBe(1);

        await reader.cancel('stop-now');
        source.releasePull();
        await pendingRead;

        expect(source.cancelReasons).toEqual(['stop-now']);
    });

    it('user sees a mid-stream upstream read failure surface as a read error', async () => {
        const source = createSource(4, { errorAtChunk: 1 });
        const response = await openResponse(source);

        const reader = response.body!.getReader();
        await reader.read();

        await expect(reader.read()).rejects.toThrow('upstream read failed');
        await settle();

        expect(source.readerCancelReasons).toHaveLength(1);
        expect(source.stream.locked).toBe(false);
    });

    it('user sees the upstream reader released once the response fully drains', async () => {
        const source = createSource(3);
        const response = await openResponse(source);

        const reader = response.body!.getReader();
        for (;;) {
            const { done } = await reader.read();
            if (done) break;
        }
        await settle();

        expect(source.stream.locked).toBe(false);
        expect(source.cancelReasons).toEqual([]);
    });
});
