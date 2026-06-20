import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import { ensurePersistedAttachmentIndex } from '@/services/AgentService/infrastructure/attachments';

const {
    convertFileSrcMock,
    copyFileMock,
    createAttachmentRecordMock,
    digestMock,
    existsMock,
    fetchMock,
    findAttachmentByHashMock,
    fullNameMock,
    getAppDirectoryPathMock,
    iconMock,
    joinMock,
    mkdirMock,
    randomUUIDMock,
    sizeMock,
    writeFileMock,
} = vi.hoisted(() => ({
    convertFileSrcMock: vi.fn(),
    copyFileMock: vi.fn(),
    createAttachmentRecordMock: vi.fn(),
    digestMock: vi.fn(),
    existsMock: vi.fn(),
    fetchMock: vi.fn(),
    findAttachmentByHashMock: vi.fn(),
    fullNameMock: vi.fn(),
    getAppDirectoryPathMock: vi.fn(),
    iconMock: vi.fn(),
    joinMock: vi.fn(),
    mkdirMock: vi.fn(),
    randomUUIDMock: vi.fn(),
    sizeMock: vi.fn(),
    writeFileMock: vi.fn(),
}));

vi.mock('@database', () => ({
    db: {},
}));

vi.mock('@database/queries', () => ({
    createAttachmentRecord: createAttachmentRecordMock,
    findAttachmentByHash: findAttachmentByHashMock,
}));

vi.mock('@services/NativeService', () => ({
    native: {
        paths: {
            getAppDirectoryPath: getAppDirectoryPathMock,
        },
    },
}));

vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: convertFileSrcMock,
}));

vi.mock('@tauri-apps/api/path', () => ({
    join: joinMock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    copyFile: copyFileMock,
    exists: existsMock,
    mkdir: mkdirMock,
    writeFile: writeFileMock,
}));

vi.mock('tauri-plugin-fs-pro-api', () => ({
    fullName: fullNameMock,
    icon: iconMock,
    size: sizeMock,
}));

function buildDraftAttachment(path = 'C:/source/report.txt'): AttachmentIndex {
    return {
        id: 'draft-attachment',
        type: 'file',
        path,
        originPath: path,
        name: 'report.txt',
        size: 12,
        supportStatus: 'supported',
    };
}

function expectedCachePath(hash: string): string {
    return `C:/TouchAI/cache/attachments/files/${hash.slice(0, 3)}/${hash}`;
}

describe('attachment storage persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        const digest = new Uint8Array(32);
        digest.forEach((_, index) => {
            digest[index] = index;
        });

        digestMock.mockResolvedValue(digest.buffer);
        randomUUIDMock.mockReturnValue('generated-id');
        vi.stubGlobal('crypto', {
            randomUUID: randomUUIDMock,
            subtle: {
                digest: digestMock,
            },
        });

        fetchMock.mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        });
        vi.stubGlobal('fetch', fetchMock);

        convertFileSrcMock.mockImplementation((path: string) => `asset://${path}`);
        getAppDirectoryPathMock.mockResolvedValue('C:/TouchAI/cache');
        joinMock.mockImplementation(async (...parts: string[]) => parts.join('/'));
        mkdirMock.mockResolvedValue(undefined);
        fullNameMock.mockResolvedValue('report.txt');
        sizeMock.mockResolvedValue(12);
        iconMock.mockImplementation(async (path: string) => `${path}.ico`);
        createAttachmentRecordMock.mockRejectedValue(new Error('unexpected insert'));
    });

    it('restores a missing cache file before reusing an existing hash record', async () => {
        existsMock.mockResolvedValue(false);
        findAttachmentByHashMock.mockImplementation(async (hash: string) => ({
            id: 42,
            hash,
            type: 'file',
            original_name: 'report.txt',
            origin_path: 'C:/source/report.txt',
            mime_type: null,
            size: 12,
            created_at: '2026-01-01T00:00:00.000Z',
        }));

        const attachment = buildDraftAttachment();
        const persisted = await ensurePersistedAttachmentIndex(attachment, {} as never);

        expect(findAttachmentByHashMock).toHaveBeenCalled();
        const [hash] = findAttachmentByHashMock.mock.calls[0]!;
        const cachePath = expectedCachePath(hash);

        expect(persisted.id).toBe(42);
        expect(createAttachmentRecordMock).not.toHaveBeenCalled();
        expect(copyFileMock).toHaveBeenCalledWith('C:/source/report.txt', cachePath);
        expect(attachment.attachmentId).toBe(42);
        expect(attachment.hash).toBe(hash);
        expect(attachment.path).toBe(cachePath);
        expect(attachment.preview).toBe(`asset://${cachePath}.ico`);
    });

    it('does not copy an existing cache file when reusing a hash record', async () => {
        existsMock.mockResolvedValue(true);
        findAttachmentByHashMock.mockImplementation(async (hash: string) => ({
            id: 43,
            hash,
            type: 'file',
            original_name: 'report.txt',
            origin_path: 'C:/source/report.txt',
            mime_type: null,
            size: 12,
            created_at: '2026-01-01T00:00:00.000Z',
        }));

        const persisted = await ensurePersistedAttachmentIndex(buildDraftAttachment(), {} as never);

        expect(persisted.id).toBe(43);
        expect(createAttachmentRecordMock).not.toHaveBeenCalled();
        expect(copyFileMock).not.toHaveBeenCalled();
    });
});
