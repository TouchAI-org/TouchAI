import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildReadApprovalRequest,
    buildReadConversationSemantic,
    executeReadFile,
} from '@/services/BuiltInToolService/tools/read/helper';

const { readDirMock, readTextFileLinesMock, statMock, openMock, createAttachmentMock } = vi.hoisted(
    () => ({
        createAttachmentMock: vi.fn(),
        openMock: vi.fn(),
        readDirMock: vi.fn(),
        readTextFileLinesMock: vi.fn(),
        statMock: vi.fn(),
    })
);

vi.mock('@tauri-apps/api/path', () => ({
    basename: vi.fn(async (path: string) => path.split(/[\\/]/).pop() ?? path),
    desktopDir: vi.fn(async () => 'C:\\Users\\tester\\Desktop'),
    dirname: vi.fn(async (path: string) => path.replace(/[\\/][^\\/]*$/, '')),
    isAbsolute: vi.fn(async (path: string) => /^[A-Z]:\\/i.test(path)),
    resolve: vi.fn(async (base: string, path: string) => `${base}\\${path}`),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    open: openMock,
    readDir: readDirMock,
    readTextFileLines: readTextFileLinesMock,
    stat: statMock,
}));

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    createAttachment: createAttachmentMock,
}));

describe('Read approval i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        readDirMock.mockResolvedValue([]);
        readTextFileLinesMock.mockResolvedValue((async function* () {})());
        statMock.mockResolvedValue({ isDirectory: false, size: 0 });
        openMock.mockResolvedValue({
            close: vi.fn(),
            read: vi.fn(async () => 0),
        });
        createAttachmentMock.mockImplementation(async (type: string, path: string) => ({
            id: `${type}:${path}`,
            type,
            name: path.split(/[\\/]/).pop() ?? path,
            originPath: path,
            size: 1,
        }));
    });

    it('creates an English approval request when the active locale is English', async () => {
        setLocale('en-US');

        const approval = await buildReadApprovalRequest({
            filePath: 'notes.txt',
        });

        expect(approval).toMatchObject({
            title: 'Confirm local content read',
            command: 'C:\\Users\\tester\\Desktop\\notes.txt',
            reason: 'This operation reads local file or directory contents and sends the result to the model.',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
        });
    });

    it('formats fallback conversation target in English', () => {
        setLocale('en-US');

        expect(buildReadConversationSemantic({})).toMatchObject({
            action: 'read',
            target: 'local file',
        });
    });

    it('localizes missing path and suggestions in English', async () => {
        setLocale('en-US');
        statMock.mockRejectedValueOnce(new Error('not found'));
        readDirMock.mockResolvedValueOnce([{ name: 'notes.txt.bak' }]);

        await expect(
            executeReadFile({ filePath: 'notes.txt' }, createExecutionContext())
        ).rejects.toThrow(
            'File not found: C:\\Users\\tester\\Desktop\\notes.txt\n\nDid you mean one of these?\nnotes.txt.bak'
        );
    });

    it('localizes directory pagination in English', async () => {
        setLocale('en-US');
        statMock.mockResolvedValueOnce({ isDirectory: true, size: 0 });
        readDirMock.mockResolvedValueOnce([
            { name: 'b.txt', isDirectory: false, isSymlink: false },
            { name: 'a', isDirectory: true, isSymlink: false },
        ]);

        const result = await executeReadFile(
            { filePath: 'C:\\tmp', limit: 1 },
            createExecutionContext()
        );

        expect(result.result).toContain('(Showing 1 of 2 entries. Use offset=2 to continue.)');
        expect(result.result).not.toContain('已显示');
    });

    it('localizes text pagination and offset errors in English', async () => {
        setLocale('en-US');
        statMock.mockResolvedValue({ isDirectory: false, size: 12 });
        openMock.mockResolvedValue({
            close: vi.fn(),
            read: vi.fn(async () => 0),
        });
        readTextFileLinesMock.mockResolvedValueOnce(
            (async function* () {
                yield 'first';
                yield 'second';
            })()
        );

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\notes.txt', limit: 1 },
            createExecutionContext()
        );
        expect(result.result).toContain('(Showing lines 1-1 of 2. Use offset=2 to continue.)');

        readTextFileLinesMock.mockResolvedValueOnce(
            (async function* () {
                yield 'only';
            })()
        );
        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt', offset: 3 }, createExecutionContext())
        ).rejects.toThrow('Offset 3 is out of range for this file (1 lines)');
    });

    it('localizes cancellation, binary, and media results in English', async () => {
        setLocale('en-US');
        statMock.mockResolvedValue({ isDirectory: false, size: 12 });
        openMock.mockResolvedValueOnce({
            close: vi.fn(),
            read: vi.fn(async (buffer: Uint8Array) => {
                buffer[0] = 0;
                return 1;
            }),
        });

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\archive.bin' }, createExecutionContext())
        ).rejects.toThrow('Cannot read binary file: C:\\tmp\\archive.bin');

        readTextFileLinesMock.mockResolvedValueOnce(
            (async function* () {
                yield 'line';
            })()
        );
        const aborted = new AbortController();
        aborted.abort();
        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt' }, createExecutionContext(aborted))
        ).rejects.toThrow('Request cancelled');

        statMock.mockResolvedValueOnce({ isDirectory: false, size: 10 });
        const imageResult = await executeReadFile(
            { filePath: 'C:\\tmp\\diagram.png' },
            createExecutionContext()
        );
        expect(imageResult.result).toContain('Image attached in tool result.');
    });
});

function createExecutionContext(
    controller = new AbortController()
): Parameters<typeof executeReadFile>[1] {
    return {
        signal: controller.signal,
        callId: 'read-call',
        iteration: 1,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}
