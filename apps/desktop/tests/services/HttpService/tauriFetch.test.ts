import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTauriFetch } from '@/services/HttpService';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-http', () => ({
    fetch: fetchMock,
}));

function streamText(value: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(value));
            controller.close();
        },
    });
}

describe('HttpService createTauriFetch', () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });

    it('preserves response metadata while proxying body reads through a safe stream wrapper', async () => {
        fetchMock.mockResolvedValue(
            new Response(streamText('hello from tauri'), {
                status: 202,
                statusText: 'Accepted',
                headers: {
                    'x-touchai-test': 'yes',
                },
            })
        );

        const tauriFetch = createTauriFetch();
        const response = await tauriFetch(new URL('https://example.test/stream'), {
            method: 'POST',
        });

        expect(fetchMock).toHaveBeenCalledWith('https://example.test/stream', {
            method: 'POST',
        });
        expect(response.status).toBe(202);
        expect(response.statusText).toBe('Accepted');
        expect(response.headers.get('x-touchai-test')).toBe('yes');
        await expect(response.text()).resolves.toBe('hello from tauri');
    });

    it('returns body-less responses without replacing the response object', async () => {
        const bodylessResponse = new Response(null, { status: 204 });
        fetchMock.mockResolvedValue(bodylessResponse);

        const tauriFetch = createTauriFetch();

        await expect(tauriFetch('https://example.test/empty')).resolves.toBe(bodylessResponse);
    });

    it('treats body cancellation errors as idempotent stream cleanup', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                new ReadableStream<Uint8Array>({
                    pull() {
                        // Keep the source stream pending until the consumer cancels the wrapper.
                    },
                })
            )
        );

        const tauriFetch = createTauriFetch();
        const response = await tauriFetch('https://example.test/pending');
        const reader = response.body?.getReader();

        await expect(reader?.cancel('consumer stopped reading')).resolves.toBeUndefined();
    });
});
