import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPersistedAttachmentFromData } from './storage';

const {
    mockCreateAttachmentRecord,
    mockFindAttachmentByHash,
    mockConvertFileSrc,
    mockJoin,
    mockCopyFile,
    mockExists,
    mockMkdir,
    mockWriteFile,
    mockGetFileName,
    mockGetFileIcon,
    mockGetFileSize,
    mockGetAppDirectoryPath,
} = vi.hoisted(() => ({
    mockCreateAttachmentRecord: vi.fn(),
    mockFindAttachmentByHash: vi.fn(),
    mockConvertFileSrc: vi.fn(),
    mockJoin: vi.fn(),
    mockCopyFile: vi.fn(),
    mockExists: vi.fn(),
    mockMkdir: vi.fn(),
    mockWriteFile: vi.fn(),
    mockGetFileName: vi.fn(),
    mockGetFileIcon: vi.fn(),
    mockGetFileSize: vi.fn(),
    mockGetAppDirectoryPath: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    createAttachmentRecord: mockCreateAttachmentRecord,
    findAttachmentByHash: mockFindAttachmentByHash,
}));

vi.mock('@services/NativeService', () => ({
    native: {
        paths: {
            getAppDirectoryPath: mockGetAppDirectoryPath,
        },
    },
}));

vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: mockConvertFileSrc,
}));

vi.mock('@tauri-apps/api/path', () => ({
    join: mockJoin,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    copyFile: mockCopyFile,
    exists: mockExists,
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
}));

vi.mock('tauri-plugin-fs-pro-api', () => ({
    fullName: mockGetFileName,
    icon: mockGetFileIcon,
    size: mockGetFileSize,
}));

describe('createPersistedAttachmentFromData', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetAppDirectoryPath.mockResolvedValue('C:/cache');
        mockJoin.mockImplementation(async (...parts: string[]) => parts.join('/'));
        mockConvertFileSrc.mockImplementation((path: string) => `asset:${path}`);
        mockExists.mockResolvedValue(false);
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
        mockCopyFile.mockResolvedValue(undefined);
        mockGetFileName.mockResolvedValue('old-name.pdf');
        mockGetFileSize.mockResolvedValue(123);
        mockGetFileIcon.mockResolvedValue('C:/icons/file.ico');
        mockCreateAttachmentRecord.mockResolvedValue(undefined);
    });

    it('preserves current origin path and name even when byte dedupe hits an existing record', async () => {
        mockFindAttachmentByHash.mockResolvedValue({
            id: 7,
            hash: 'same-hash',
            type: 'file',
            original_name: 'old-name.pdf',
            origin_path: 'D:/old/source.pdf',
            mime_type: 'application/pdf',
            size: 99,
            created_at: '2026-04-09T00:00:00.000Z',
        });

        const attachment = await createPersistedAttachmentFromData({
            type: 'file',
            name: 'new-name.pdf',
            originPath: 'mcp://tool-result/server/call/file-1',
            mimeType: 'application/pdf',
            size: 321,
            data: new Uint8Array([1, 2, 3]),
        });

        expect(attachment.attachmentId).toBe(7);
        expect(attachment.originPath).toBe('mcp://tool-result/server/call/file-1');
        expect(attachment.name).toBe('new-name.pdf');
        expect(attachment.size).toBe(321);
        expect(attachment.mimeType).toBe('application/pdf');
    });
});
