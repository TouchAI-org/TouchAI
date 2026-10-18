import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTauriFetch } from '@/services/AgentService/infrastructure/providers/ai-sdk/tauriFetch';

const tauriFetchMock = vi.fn();

vi.mock('@tauri-apps/plugin-http', () => ({
    fetch: (...args: unknown[]) => tauriFetchMock(...args),
}));

type PullProbe = {
    pulls: number;
    queued: number;
};

function createPullStream(probe: PullProbe, totalChunks: number): ReadableStream<Uint8Array> {
    let emitted = 0;
    return new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                probe.pulls += 1;
                if (emitted >= totalChunks) {
                    controller.close();
                    return;
                }
                emitted += 1;
                probe.queued += 1;
                controller.enqueue(new Uint8Array([emitted]));
            },
            cancel() {
                probe.cancelled += 1;
            },
        },
        { highWaterMark: 1 }
    );
}

function mockResponse(body: ReadableStream<Uint8Array> | null): Response {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

describe('createTauriFetch readable stream forwarding', () => {
    beforeEach(() => {
        tauriFetchMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        tauriFetchMock.mockReset();
    });

    it('does not drain upstream while downstream is not consuming', async () => {
        const probe: PullProbe = { pulls: 0, queued: 0, cancelled: 0 };
        tauriFetchMock.mockResolvedValue(mockResponse(createPullStream(probe, 100)));

        const fetchImpl = createTauriFetch();
        await fetchImpl('https://example.test/stream');
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 只允许引擎为高水位预取少量数据；关键是不能把 100 个 chunk 全部拉进队列。
        expect(probe.queued).toBeLessThanOrEqual(2);
    });

    it('cancels the locked upstream when downstream is cancelled', async () => {
        const probe: PullProbe = { pulls: 0, queued: 0, cancelled: 0 };
        tauriFetchMock.mockResolvedValue(mockResponse(createPullStream(probe, 10)));

        const fetchImpl = createTauriFetch();
        const response = await fetchImpl('https://example.test/stream');
        const reader = response.body!.getReader();

        await reader.read();
        await reader.cancel('client cancelled');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(probe.cancelled).toBe(1);
    });

    it('closes the downstream stream once upstream completes', async () => {
        const probe: PullProbe = { pulls: 0, queued: 0, cancelled: 0 };
        tauriFetchMock.mockResolvedValue(mockResponse(createPullStream(probe, 1)));

        const fetchImpl = createTauriFetch();
        const response = await fetchImpl('https://example.test/stream');

        await expect(new Response(response.body).text()).resolves.toHaveLength(1);
    });

    it('swallows tauri resource errors when the upstream is already released', async () => {
        let upstreamCancelled = 0;
        const releasing = new ReadableStream<Uint8Array>({
            cancel() {
                upstreamCancelled += 1;
                return Promise.reject(new Error('The resource id 7 is invalid'));
            },
        });
        tauriFetchMock.mockResolvedValue(mockResponse(releasing));

        const fetchImpl = createTauriFetch();
        const response = await fetchImpl('https://example.test/released');
        const reader = response.body!.getReader();

        await expect(reader.cancel()).resolves.toBeUndefined();
        expect(upstreamCancelled).toBe(1);
    });

    it('propagates upstream read errors to the consumer', async () => {
        const failing = new ReadableStream<Uint8Array>({
            pull() {
                throw new Error('upstream broke');
            },
        });
        tauriFetchMock.mockResolvedValue(mockResponse(failing));

        const fetchImpl = createTauriFetch();
        const response = await fetchImpl('https://example.test/failing');

        await expect(new Response(response.body).text()).rejects.toThrow('upstream broke');
    });

    it('returns responses without a body unchanged', async () => {
        tauriFetchMock.mockResolvedValue(mockResponse(null));

        const fetchImpl = createTauriFetch();
        const response = await fetchImpl('https://example.test/empty');

        expect(response.body).toBeNull();
    });
});
