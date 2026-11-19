import { convertFileSrc } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAttachmentParts } from '@/modules/attachments/materialize.io';

const fetchFile = vi.fn<typeof fetch>();
function createAttachment(id: string) {
    return {
        id,
        type: 'image' as const,
        name: `${id}.png`,
        path: `D:/${id}.png`,
        originPath: `D:/${id}.png`,
        supportStatus: 'supported' as const,
    };
}

beforeEach(() => {
    fetchFile.mockReset();
    fetchFile.mockImplementation(async (url) => {
        const name = String(url) === convertFileSrc('D:/a.png') ? 'a' : 'b';
        return new Response(name);
    });
    vi.stubGlobal('fetch', fetchFile);
});
afterEach(() => vi.unstubAllGlobals());

describe('given image references in one model request', () => {
    it('user references the same image twice and receives both parts from one source read', async () => {
        const parts = await buildAttachmentParts([createAttachment('a'), createAttachment('a')], {
            includeAnchorText: false,
        });

        expect(parts).toEqual([
            expect.objectContaining({ sourcePath: 'D:/a.png', data: btoa('a') }),
            expect.objectContaining({ sourcePath: 'D:/a.png', data: btoa('a') }),
        ]);
        expect(fetchFile).toHaveBeenCalledTimes(1);
        expect(fetchFile).toHaveBeenCalledWith(convertFileSrc('D:/a.png'), { signal: undefined });
    });

    it('user references distinct images and receives the content of each source', async () => {
        const parts = await buildAttachmentParts([createAttachment('a'), createAttachment('b')], {
            includeAnchorText: false,
        });

        expect(parts).toEqual([
            expect.objectContaining({ sourcePath: 'D:/a.png', data: btoa('a') }),
            expect.objectContaining({ sourcePath: 'D:/b.png', data: btoa('b') }),
        ]);
        expect(fetchFile).toHaveBeenCalledTimes(2);
    });

    it('user references an unavailable image twice and keeps the readable image without repeating the failed read', async () => {
        fetchFile.mockRejectedValueOnce(new Error('File unavailable'));
        const parts = await buildAttachmentParts(
            [createAttachment('missing'), createAttachment('missing'), createAttachment('ok')],
            { includeAnchorText: false }
        );

        expect(parts).toEqual([
            expect.objectContaining({ sourcePath: 'D:/ok.png', data: btoa('b') }),
        ]);
        expect(fetchFile).toHaveBeenCalledTimes(2);
    });
});
