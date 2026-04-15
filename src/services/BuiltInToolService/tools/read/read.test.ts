import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeReadTool, readTool } from './index';

const {
    mockBasename,
    mockDesktopDir,
    mockDirname,
    mockIsAbsolute,
    mockResolvePath,
    mockOpen,
    mockReadDir,
    mockReadTextFileLines,
    mockStat,
    mockCreateAttachment,
} = vi.hoisted(() => ({
    mockBasename: vi.fn(),
    mockDesktopDir: vi.fn(),
    mockDirname: vi.fn(),
    mockIsAbsolute: vi.fn(),
    mockResolvePath: vi.fn(),
    mockOpen: vi.fn(),
    mockReadDir: vi.fn(),
    mockReadTextFileLines: vi.fn(),
    mockStat: vi.fn(),
    mockCreateAttachment: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
    basename: mockBasename,
    desktopDir: mockDesktopDir,
    dirname: mockDirname,
    isAbsolute: mockIsAbsolute,
    resolve: mockResolvePath,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    open: mockOpen,
    readDir: mockReadDir,
    readTextFileLines: mockReadTextFileLines,
    stat: mockStat,
}));

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    createAttachment: mockCreateAttachment,
}));

function createLineIterator(lines: string[]): AsyncIterableIterator<string> {
    return (async function* () {
        for (const line of lines) {
            yield line;
        }
    })();
}

function createContext() {
    return {
        callId: 'call-1',
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
    };
}

describe('executeReadTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDesktopDir.mockResolvedValue('C:/Users/test/Desktop');
        mockResolvePath.mockImplementation(async (...paths: string[]) => paths.join('/'));
        mockDirname.mockResolvedValue('C:/workspace');
        mockBasename.mockResolvedValue('missing.txt');
        mockIsAbsolute.mockResolvedValue(true);
        mockOpen.mockResolvedValue({
            read: vi.fn().mockImplementation(async (buffer: Uint8Array) => {
                buffer.set(new TextEncoder().encode('export const answer = 42;'));
                return 25;
            }),
            close: vi.fn().mockResolvedValue(undefined),
        });
    });

    it('reads text files with line numbers and pagination hints', async () => {
        mockStat.mockResolvedValue({
            isDirectory: false,
            size: 128,
        });
        mockReadTextFileLines.mockResolvedValue(
            createLineIterator(['export const answer = 42;', 'console.log(answer);'])
        );

        const result = await executeReadTool(
            {
                filePath: 'C:/workspace/main.ts',
                offset: 1,
                limit: 1,
            },
            {},
            createContext()
        );

        expect(result.isError).toBe(false);
        expect(result.status).toBe('success');
        expect(result.result).toContain('<path>C:/workspace/main.ts</path>');
        expect(result.result).toContain('1: export const answer = 42;');
        expect(result.result).toContain('Use offset=2 to continue.');
    });

    it('builds approval request before reading local content', async () => {
        const approval = await readTool.buildApprovalRequest({
            filePath: 'C:/workspace/main.ts',
        });

        expect(approval).not.toBeNull();
        expect(approval).toMatchObject({
            title: '读取本地内容确认',
            command: 'C:/workspace/main.ts',
            approveLabel: '批准',
            rejectLabel: '拒绝',
        });
    });

    it('returns directory listings for directories', async () => {
        mockStat.mockResolvedValue({
            isDirectory: true,
            size: 0,
        });
        mockReadDir.mockResolvedValue([
            { name: 'src', isDirectory: true, isFile: false, isSymlink: false },
            { name: 'README.md', isDirectory: false, isFile: true, isSymlink: false },
        ]);

        const result = await executeReadTool(
            {
                filePath: 'C:/workspace',
            },
            {},
            createContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('<type>directory</type>');
        expect(result.result).toContain('README.md');
        expect(result.result).toContain('src/');
    });

    it('returns pdf files as tool-result attachments', async () => {
        mockStat.mockResolvedValue({
            isDirectory: false,
            size: 2048,
        });
        mockCreateAttachment.mockResolvedValue({
            id: 'attachment-1',
            type: 'file',
            path: 'C:/workspace/manual.pdf',
            originPath: 'C:/workspace/manual.pdf',
            name: 'manual.pdf',
            supportStatus: 'supported',
        });

        const result = await executeReadTool(
            {
                filePath: 'C:/workspace/manual.pdf',
            },
            {},
            createContext()
        );

        expect(result.isError).toBe(false);
        expect(result.attachments).toEqual([
            expect.objectContaining({
                path: 'C:/workspace/manual.pdf',
            }),
        ]);
        expect(result.result).toContain('<type>pdf</type>');
    });

    it('rejects binary files that are not images or pdfs', async () => {
        mockStat.mockResolvedValue({
            isDirectory: false,
            size: 4,
        });
        mockOpen.mockResolvedValue({
            read: vi.fn().mockImplementation(async (buffer: Uint8Array) => {
                buffer.set(new Uint8Array([0, 1, 2, 3]));
                return 4;
            }),
            close: vi.fn().mockResolvedValue(undefined),
        });

        const result = await executeReadTool(
            {
                filePath: 'C:/workspace/archive.bin',
            },
            {},
            createContext()
        );

        expect(result.isError).toBe(true);
        expect(result.result).toBe('Cannot read binary file: C:/workspace/archive.bin');
    });
});
