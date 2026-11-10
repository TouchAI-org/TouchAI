import { describe, expect, it } from 'vitest';

import { cancelResponseBody } from '@/services/HttpService/cancel';

describe('user discards an HTTP response without masking the original failure', () => {
    it('user keeps the caller failure when the response body is locked', async () => {
        const response = new Response(new ReadableStream<Uint8Array>({ pull() {} }));
        const reader = response.body!.getReader();

        await expect(cancelResponseBody(response, 'discard')).resolves.toBeUndefined();

        reader.releaseLock();
    });

    it('user keeps the caller failure when the wrapper rejects cancellation', async () => {
        const response = new Response(
            new ReadableStream<Uint8Array>({
                pull() {},
                cancel() {
                    throw new Error('native resource already released');
                },
            })
        );

        await expect(cancelResponseBody(response, 'discard')).resolves.toBeUndefined();
    });
});
