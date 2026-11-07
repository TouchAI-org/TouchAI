import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getImageThumbnail, resetImageThumbnailCache } from '@/utils/imageThumbnail';

const createObjectURLMock = vi.fn();
const revokeObjectURLMock = vi.fn();
const createImageBitmapMock = vi.fn();
const fetchMock = vi.fn();

describe('image thumbnail cache', () => {
    beforeEach(() => {
        createObjectURLMock.mockReset();
        revokeObjectURLMock.mockReset();
        createImageBitmapMock.mockReset();
        fetchMock.mockReset();

        let urlIndex = 0;
        createObjectURLMock.mockImplementation(() => `blob:thumb-${++urlIndex}`);
        createImageBitmapMock.mockResolvedValue({
            width: 4000,
            height: 3000,
            close: vi.fn(),
        });
        fetchMock.mockResolvedValue({
            ok: true,
            blob: async () => new Blob(['image']),
        });

        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: createObjectURLMock,
            revokeObjectURL: revokeObjectURLMock,
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('createImageBitmap', createImageBitmapMock);

        const canvasContext = { drawImage: vi.fn() };
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
            canvasContext as unknown as CanvasRenderingContext2D
        );
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
            callback(new Blob(['thumb'], { type: 'image/webp' }));
        });
    });

    afterEach(() => {
        resetImageThumbnailCache();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('downscales to the requested width and reuses the cached url', async () => {
        const first = await getImageThumbnail('asset://photo.jpg', 200);
        const second = await getImageThumbnail('asset://photo.jpg', 200);

        expect(first).toBe(second);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    });

    it('shares one decode between concurrent callers', async () => {
        const [left, right] = await Promise.all([
            getImageThumbnail('asset://photo.jpg', 200),
            getImageThumbnail('asset://photo.jpg', 200),
        ]);

        expect(left).toBe(right);
        expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    });

    it('keeps separate cache entries for different widths', async () => {
        await getImageThumbnail('asset://photo.jpg', 200);
        await getImageThumbnail('asset://photo.jpg', 320);

        expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
    });

    it('evicts and revokes the oldest thumbnails beyond the budget', async () => {
        for (let index = 0; index < 45; index += 1) {
            await getImageThumbnail(`asset://photo-${index}.jpg`, 200);
        }

        // 预算 40 张：最旧 5 张被回收。
        expect(revokeObjectURLMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
});
