// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createAttachment,
    createPersistedAttachmentFromData,
    ensurePersistedAttachmentIndex,
    hydratePersistedAttachments,
    persistPreparedAttachment,
    prepareAttachmentForPersistence,
} from '@/services/AgentService/infrastructure/attachments/storage';
import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments/types';

/**
 * Attachments are copied into an app-owned cache and deduplicated by content hash. Getting this
 * wrong either loses the user's file, copies the same bytes once per send, or hands the model a
 * path that no longer exists.
 */
const mocks = vi.hoisted(() => ({
    createAttachmentRecord: vi.fn(),
    findAttachmentByHash: vi.fn(),
    getAppDirectoryPath: vi.fn(),
    convertFileSrc: vi.fn(),
    join: vi.fn(),
    copyFile: vi.fn(),
    exists: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    getFileName: vi.fn(),
    getFileIcon: vi.fn(),
    getFileSize: vi.fn(),
}));

vi.mock('@database', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database')>()),
    db: { __tag: 'db' },
}));

vi.mock('@database/queries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database/queries')>()),
    createAttachmentRecord: mocks.createAttachmentRecord,
    findAttachmentByHash: mocks.findAttachmentByHash,
}));

vi.mock('@services/NativeService', () => ({
    native: { paths: { getAppDirectoryPath: mocks.getAppDirectoryPath } },
}));

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: mocks.convertFileSrc }));

vi.mock('@tauri-apps/api/path', () => ({
    join: (...parts: string[]) => Promise.resolve(parts.join('/')),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    copyFile: mocks.copyFile,
    exists: mocks.exists,
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
}));

vi.mock('tauri-plugin-fs-pro-api', () => ({
    fullName: mocks.getFileName,
    icon: mocks.getFileIcon,
    size: mocks.getFileSize,
}));

/** A 32-byte payload; the real hash is computed by the platform crypto. */
const sampleBytes = new Uint8Array(32).fill(7);

const originalFetch = globalThis.fetch;

beforeEach(() => {
    vi.clearAllMocks();
    // Hashing reads the file through fetch(convertFileSrc(path)); jsdom cannot resolve asset://.
    globalThis.fetch = vi.fn(async () => ({
        ok: true,
        statusText: 'OK',
        arrayBuffer: async () => new Uint8Array(32).fill(7).buffer,
    })) as never;
    mocks.getAppDirectoryPath.mockResolvedValue('/cache');
    mocks.convertFileSrc.mockImplementation((path: string) => `asset://${path}`);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.exists.mockResolvedValue(false);
    mocks.getFileName.mockResolvedValue('report.pdf');
    mocks.getFileIcon.mockResolvedValue('/icons/pdf.png');
    mocks.getFileSize.mockResolvedValue(2048);
    mocks.findAttachmentByHash.mockResolvedValue(null);
    mocks.createAttachmentRecord.mockImplementation(async (record: { hash: string }) => ({
        id: 11,
        ...record,
        created_at: '2026-01-01T00:00:00Z',
    }));
});

function attachment(overrides: Partial<AttachmentIndex> = {}): AttachmentIndex {
    return {
        id: 'local-1',
        type: 'file',
        path: '/downloads/report.pdf',
        originPath: '/downloads/report.pdf',
        name: 'report.pdf',
        size: 2048,
        preview: 'asset:///icons/pdf.png',
        mimeType: 'application/pdf',
        supportStatus: 'supported',
        ...overrides,
    };
}

describe('user attaches a file to a message', () => {
    it('user gets the image mime type from its extension', async () => {
        const result = await createAttachment('image', '/pictures/photo.JPG');

        // Case must not matter: a .JPG is still a JPEG.
        expect(result.mimeType).toBe('image/jpeg');
    });

    it('user gets a safe default when the image extension is unknown', async () => {
        const result = await createAttachment('image', '/pictures/scan.xyz');

        expect(result.mimeType).toBe('image/png');
    });

    it('user gets no mime type guessed for a non-image file', async () => {
        const result = await createAttachment('file', '/downloads/report.pdf');

        expect(result.mimeType).toBeUndefined();
    });

    it('user gets the image itself as its own preview', async () => {
        const result = await createAttachment('image', '/pictures/photo.png');

        expect(result.preview).toBe('asset:///pictures/photo.png');
        expect(mocks.getFileIcon).not.toHaveBeenCalled();
    });

    it('user gets a file icon as the preview for a non-image', async () => {
        const result = await createAttachment('file', '/downloads/report.pdf');

        expect(mocks.getFileIcon).toHaveBeenCalledWith('/downloads/report.pdf', { size: 256 });
        expect(result.preview).toBe('asset:///icons/pdf.png');
    });

    it('user gets the file name and size shown before sending', async () => {
        const result = await createAttachment('file', '/downloads/report.pdf');

        expect(result).toMatchObject({ name: 'report.pdf', size: 2048, type: 'file' });
        expect(result.originPath).toBe('/downloads/report.pdf');
    });

    it('user gets the attachment marked supported so it can be sent', async () => {
        const result = await createAttachment('file', '/downloads/report.pdf');

        expect(result.supportStatus).toBe('supported');
    });
});

describe('user sends a message with attachments', () => {
    it('user gets an attachment copied into the cache and recorded once', async () => {
        const index = attachment();

        await persistPreparedAttachment(index);

        expect(mocks.copyFile).toHaveBeenCalledWith(
            '/downloads/report.pdf',
            expect.stringContaining('/cache/attachments/files/')
        );
        expect(mocks.createAttachmentRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                original_name: 'report.pdf',
                origin_path: '/downloads/report.pdf',
            }),
            expect.anything()
        );
    });

    it('user gets the same bytes stored only once', async () => {
        mocks.findAttachmentByHash.mockResolvedValue({ id: 5, hash: 'abc', type: 'file' });

        const index = attachment();
        await persistPreparedAttachment(index);

        // A second row for the same bytes would duplicate every re-sent file.
        expect(mocks.createAttachmentRecord).not.toHaveBeenCalled();
        expect(index.attachmentId).toBe(5);
    });

    it('user gets an already persisted attachment reused without touching disk', async () => {
        const index = attachment({ attachmentId: 9, hash: 'deadbeef' });

        const persisted = await persistPreparedAttachment(index);

        expect(persisted).toMatchObject({ id: 9, hash: 'deadbeef' });
        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it('user gets the local attachment filled in with its persisted identity', async () => {
        const index = attachment();

        await persistPreparedAttachment(index);

        // The renderer keeps using this object, so it has to learn the id and cache path.
        expect(index.attachmentId).toBe(11);
        expect(index.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(index.path).toContain('/cache/attachments/files/');
        expect(index.preview).toContain('asset://');
    });

    it('user gets the record found again when another writer wins the insert race', async () => {
        mocks.createAttachmentRecord.mockRejectedValue(new Error('UNIQUE constraint failed'));
        mocks.findAttachmentByHash
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 77, hash: 'race', type: 'file' });

        const index = attachment();
        await persistPreparedAttachment(index);

        // Two sends of the same file can race; the loser must adopt the winner's row.
        expect(index.attachmentId).toBe(77);
    });

    it('user gets the original error when the insert fails for another reason', async () => {
        mocks.createAttachmentRecord.mockRejectedValue(new Error('disk full'));

        await expect(persistPreparedAttachment(attachment())).rejects.toThrow('disk full');
    });
});

describe('user attaches a tool result as a file', () => {
    it('user gets the bytes written when the cache does not have them', async () => {
        mocks.exists.mockResolvedValue(false);

        await createPersistedAttachmentFromData({
            type: 'image',
            name: 'chart.png',
            originPath: 'tool://chart',
            mimeType: 'image/png',
            data: sampleBytes,
        });

        expect(mocks.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('/cache/attachments/images/'),
            sampleBytes
        );
    });

    it('user gets the bytes reused when the cache already has them', async () => {
        mocks.exists.mockResolvedValue(true);

        await createPersistedAttachmentFromData({
            type: 'image',
            name: 'chart.png',
            originPath: 'tool://chart',
            data: sampleBytes,
        });

        // Re-writing identical bytes wastes disk on every tool call.
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('user gets this send origin kept even when the bytes are a duplicate', async () => {
        mocks.findAttachmentByHash.mockResolvedValue({
            id: 3,
            hash: 'old',
            type: 'image',
            original_name: 'old-name.png',
            origin_path: 'tool://old',
            mime_type: 'image/png',
            size: 10,
        });

        const result = await createPersistedAttachmentFromData({
            type: 'image',
            name: 'chart.png',
            originPath: 'tool://chart',
            data: sampleBytes,
        });

        // The reused row describes an older send; this message still came from this tool call.
        expect(result).toMatchObject({ name: 'chart.png', originPath: 'tool://chart' });
    });

    it('user gets the byte length used when no size is given', async () => {
        const result = await createPersistedAttachmentFromData({
            type: 'file',
            name: 'blob.bin',
            originPath: 'tool://blob',
            data: sampleBytes,
        });

        expect(result.size).toBe(sampleBytes.byteLength);
    });
});

describe('user reopens a conversation with attachments', () => {
    it('user gets each stored attachment restored as a usable reference', async () => {
        const restored = await hydratePersistedAttachments([
            {
                id: 1,
                hash: 'aaa',
                type: 'image',
                original_name: 'photo.png',
                origin_path: '/pictures/photo.png',
                mime_type: 'image/png',
                size: 100,
                created_at: '2026-01-01T00:00:00Z',
                message_id: 1,
                sort_order: 0,
                tool_call_id: null,
                tool_kind: null,
            },
        ]);

        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
            attachmentId: 1,
            hash: 'aaa',
            name: 'photo.png',
            mimeType: 'image/png',
            supportStatus: 'supported',
        });
        expect(restored[0]!.path).toContain('/cache/attachments/images/');
    });

    it('user gets no attachment restored when the message had none', async () => {
        await expect(hydratePersistedAttachments([])).resolves.toEqual([]);
    });
});

describe('user prepares an attachment before the write transaction', () => {
    it('user gets the file copied once for a new attachment', async () => {
        const index = attachment();

        await prepareAttachmentForPersistence(index);
        await persistPreparedAttachment(index);

        // Preparing exists so the slow copy happens outside the transaction, once.
        expect(mocks.copyFile).toHaveBeenCalledTimes(1);
    });

    it('user gets nothing prepared for an attachment that is already persisted', async () => {
        await prepareAttachmentForPersistence(attachment({ attachmentId: 4, hash: 'abc' }));

        expect(mocks.copyFile).not.toHaveBeenCalled();
    });
});

describe('user attaches a file that cannot be read', () => {
    it('user gets a clear error naming the failure', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: false,
            statusText: 'Not Found',
        })) as never;

        await expect(persistPreparedAttachment(attachment())).rejects.toThrow(
            'Failed to read attachment: Not Found'
        );
    });

    it('user gets both attachments stored under the same cache root', async () => {
        await persistPreparedAttachment(attachment({ path: '/a/one.pdf' }));
        await persistPreparedAttachment(attachment({ path: '/a/two.pdf' }));

        // Both copies must land under the one app-owned cache directory.
        const targets = mocks.copyFile.mock.calls.map((call) => String(call[1]));
        expect(targets).toHaveLength(2);
        for (const target of targets) {
            expect(target).toContain('/cache/attachments/files/');
        }
    });
});

afterAll(() => {
    globalThis.fetch = originalFetch;
});

describe('user sends an attachment through the runtime entry point', () => {
    it('user gets the same record the direct call would produce', async () => {
        const index = attachment({ attachmentId: 21, hash: 'fff' });

        const record = await ensurePersistedAttachmentIndex(index);

        expect(record).toMatchObject({ id: 21, hash: 'fff' });
    });
});
