import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openMock, statMock, convertFileSrcMock, normalizeImageBytesMock } = vi.hoisted(() => ({
    openMock: vi.fn(),
    statMock: vi.fn(),
    convertFileSrcMock: vi.fn((path: string) => `asset://${path}`),
    normalizeImageBytesMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: convertFileSrcMock }));
vi.mock('@tauri-apps/plugin-fs', () => ({ open: openMock, stat: statMock }));
vi.mock('@/services/AgentService/infrastructure/attachments/imageNormalization', () => ({
    normalizeImageBytes: normalizeImageBytesMock,
}));

import {
    formatAttachmentAnchorText,
    formatAttachmentNotInlined,
    readAttachmentAsText,
    readAttachmentHead,
    readAttachmentImageForTransport,
} from '@/services/AgentService/infrastructure/attachments/content';
import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments/types';

function createAttachment(overrides: Partial<AttachmentIndex> = {}): AttachmentIndex {
    return {
        id: 'a',
        type: 'file',
        name: 'notes.txt',
        path: 'D:/notes.txt',
        originPath: 'D:/notes.txt',
        supportStatus: 'supported',
        ...overrides,
    };
}

function fileWithBytes(bytes: Uint8Array) {
    let offset = 0;
    return {
        read: vi.fn(async (buffer: Uint8Array) => {
            if (offset >= bytes.length) return null;
            const end = Math.min(bytes.length, offset + buffer.length);
            buffer.set(bytes.subarray(offset, end));
            const read = end - offset;
            offset = end;
            return read;
        }),
        close: vi.fn(async () => undefined),
    };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
    vi.clearAllMocks();
    statMock.mockResolvedValue({ isFile: true, isDirectory: false, size: 10 });
    openMock.mockResolvedValue(fileWithBytes(new TextEncoder().encode('hello')));
});

describe('given an attachment is read for transport', () => {
    it('user gets a bounded head with a truncation flag', async () => {
        openMock.mockResolvedValue(fileWithBytes(new Uint8Array([1, 2, 3, 4, 5, 6])));

        const head = await readAttachmentHead('D:/notes.txt', 4);

        expect([...head.bytes]).toEqual([1, 2, 3, 4]);
        expect(head.truncated).toBe(true);
    });

    it('user gets the complete file when it fits the read window', async () => {
        openMock.mockResolvedValue(fileWithBytes(new Uint8Array([1, 2, 3, 4])));

        const head = await readAttachmentHead('D:/notes.txt', 4);

        expect([...head.bytes]).toEqual([1, 2, 3, 4]);
        expect(head.truncated).toBe(false);
    });

    it('user gets text when the file is UTF-8', async () => {
        const preview = await readAttachmentAsText(createAttachment(), { maxBytes: 10 });

        expect(preview).toEqual({ content: 'hello', isBinary: false, truncated: false });
    });

    it('user gets a binary marker instead of decoded text', async () => {
        openMock.mockResolvedValue(fileWithBytes(new Uint8Array([0x00, 0x01, 0x02, 0x03])));

        const preview = await readAttachmentAsText(createAttachment(), { maxBytes: 10 });

        expect(preview).toEqual({ content: '', isBinary: true, truncated: false });
    });

    it('user gets no read attempt for a PDF over the byte limit', async () => {
        globalThis.fetch = vi.fn() as never;

        const { readAttachmentAsBase64 } =
            await import('@/services/AgentService/infrastructure/attachments/content');
        const result = await readAttachmentAsBase64(
            createAttachment({ type: 'file', name: 'x.pdf' }),
            {
                maxBytes: 5,
            }
        );

        expect(result).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('user gets a readable image unchanged when it already fits', async () => {
        const data = 'AQID';
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        })) as never;

        const result = await readAttachmentImageForTransport(
            createAttachment({ type: 'image', name: 'small.png' })
        );

        expect(result.data).toBe(data);
        expect(normalizeImageBytesMock).not.toHaveBeenCalled();
    });

    it('user with an oversized cached image gets normalized bytes for the request', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new Uint8Array(3_375_003).buffer,
        })) as never;
        normalizeImageBytesMock.mockResolvedValue({
            bytes: new Uint8Array([4, 5, 6]),
            mimeType: 'image/jpeg',
            resized: true,
        });

        const result = await readAttachmentImageForTransport(
            createAttachment({ type: 'image', name: 'big.png' })
        );

        expect(result.mimeType).toBe('image/jpeg');
        expect(normalizeImageBytesMock).toHaveBeenCalledOnce();
    });

    it('user sees the right tool hint for binary content', () => {
        expect(formatAttachmentNotInlined('binary content', '/a.zip', 'Bash')).toContain(
            'Use the Bash tool'
        );
    });

    it('user can tell the model where the original image lives', () => {
        const text = formatAttachmentAnchorText({
            alias: 'A1',
            order: 0,
            type: 'image',
            name: 'shot.png',
            mimeType: 'image/png',
            originPath: '/Users/me/shot.png',
            attachmentId: 1,
            hash: 'hash',
        });

        expect(text).toContain('origin_path: /Users/me/shot.png');
        expect(text).toContain('inline_copy_note');
    });

    it('user sees why a local file was not inlined', () => {
        expect(formatAttachmentNotInlined('binary files are not inlined', 'D:/a.zip')).toContain(
            'D:/a.zip'
        );
    });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});
