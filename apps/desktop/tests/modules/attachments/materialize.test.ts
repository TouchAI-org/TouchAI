import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentIndex } from '@/modules/attachments';
import { buildAttachmentParts } from '@/modules/attachments';

vi.mock('@tauri-apps/api/core', async (importActual) => ({
    ...(await importActual<typeof import('@tauri-apps/api/core')>()),
    convertFileSrc: (path: string) => `asset://fixture${path}`,
}));

afterEach(() => {
    vi.unstubAllGlobals();
});

const image = (id: string): AttachmentIndex => ({
    id,
    type: 'image',
    path: `/fixture/${id}.png`,
    originPath: `/fixture/${id}.png`,
    name: `${id}.png`,
    mimeType: 'image/png',
});

describe('given Desktop attachment materialization crosses only controlled file boundaries', () => {
    it('user receives cancellation immediately and late file bytes cannot start another read or become model input', async () => {
        const pending = Promise.withResolvers<Response>();
        const requests: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            requests.push(url);
            return pending.promise;
        });
        const controller = new AbortController();
        const result = buildAttachmentParts([image('first'), image('second')], {
            signal: controller.signal,
        });
        const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
        await expect.poll(() => requests.length).toBe(1);
        controller.abort();
        await rejected;
        pending.resolve(new Response(new Uint8Array([1, 2, 3])));
        await Promise.resolve();
        await Promise.resolve();
        expect(requests).toEqual(['asset://fixture/fixture/first.png']);
    });

    it('user starts no file effect for an already cancelled draft', async () => {
        const requests: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            requests.push(url);
            return new Response(new Uint8Array([1, 2, 3]));
        });
        const controller = new AbortController();
        controller.abort();
        await expect(
            buildAttachmentParts([image('first')], { signal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests).toEqual([]);
    });

    it('user retains an inline image and its Desktop metadata when a noncancelled read succeeds', async () => {
        vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));
        expect(
            await buildAttachmentParts([image('first')], { signal: new AbortController().signal })
        ).toContainEqual(
            expect.objectContaining({
                type: 'image',
                data: 'AQID',
                sourcePath: '/fixture/first.png',
                meta: expect.objectContaining({ originPath: '/fixture/first.png' }),
            })
        );
    });
});
