import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeImageBytes } from '@/services/AgentService/infrastructure/attachments/imageNormalization';

class FakeOffscreenCanvas {
    width: number;
    height: number;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    getContext() {
        return {
            imageSmoothingEnabled: false,
            imageSmoothingQuality: 'low',
            fillStyle: '',
            drawImage: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
            fillRect: vi.fn(),
        };
    }

    convertToBlob({ type }: { type: string }) {
        const size = this.width > 1500 ? 4_600_000 : 100;
        return Promise.resolve(new Blob([new Uint8Array(size)], { type }));
    }
}

function bitmap(width: number, height: number) {
    return { width, height, close: vi.fn() };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('given an image enters the inline transport', () => {
    it('user gets the original bytes when the image already fits every limit', async () => {
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => bitmap(100, 100))
        );
        vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
        const bytes = new Uint8Array([1, 2, 3]);

        const result = await normalizeImageBytes({ bytes, mimeType: 'image/png' });

        expect(result.bytes).toBe(bytes);
        expect(result.resized).toBe(false);
    });

    it('user gets a smaller image when the longest edge exceeds the limit', async () => {
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => bitmap(4000, 2000))
        );
        vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

        const result = await normalizeImageBytes({
            bytes: new Uint8Array(1000),
            mimeType: 'image/png',
        });

        expect(result.resized).toBe(true);
        expect(result.mimeType).toBe('image/png');
        expect(result.bytes.byteLength).toBeLessThan(1000);
    });

    it('user gets a recompressed image when the encoded payload exceeds the byte limit', async () => {
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => bitmap(100, 100))
        );
        vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

        const result = await normalizeImageBytes({
            bytes: new Uint8Array(4_500_001),
            mimeType: 'image/png',
        });

        expect(result.resized).toBe(true);
        expect(result.bytes.byteLength).toBe(100);
    });

    it('user gets the original image when the browser cannot decode it', async () => {
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => {
                throw new Error('unsupported');
            })
        );
        vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
        const bytes = new Uint8Array([1, 2, 3]);

        const result = await normalizeImageBytes({ bytes, mimeType: 'image/png' });

        expect(result.bytes).toBe(bytes);
    });

    it('user gets the original image for a format the normalizer does not touch', async () => {
        const createImageBitmap = vi.fn();
        vi.stubGlobal('createImageBitmap', createImageBitmap);
        const bytes = new Uint8Array([1, 2, 3]);

        const result = await normalizeImageBytes({ bytes, mimeType: 'image/gif' });

        expect(result.bytes).toBe(bytes);
        expect(createImageBitmap).not.toHaveBeenCalled();
    });

    it('user gets the original image when canvas support is unavailable', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const result = await normalizeImageBytes({ bytes, mimeType: 'image/png' });

        expect(result.bytes).toBe(bytes);
    });

    it('user gets the original image when the canvas cannot be created', async () => {
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => bitmap(4000, 2000))
        );
        vi.stubGlobal(
            'OffscreenCanvas',
            class {
                width: number;
                height: number;
                constructor(width: number, height: number) {
                    this.width = width;
                    this.height = height;
                }
                getContext() {
                    return null;
                }
            }
        );
        const bytes = new Uint8Array(1000);

        const result = await normalizeImageBytes({ bytes, mimeType: 'image/png' });

        expect(result.bytes).toBe(bytes);
    });
});
