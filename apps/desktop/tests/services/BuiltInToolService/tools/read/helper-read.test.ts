import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildReadApprovalRequest,
    buildReadConversationSemantic,
    executeReadFile,
} from '@/services/BuiltInToolService/tools/read/helper';

/**
 * The Read tool is how the model gets at a local file, so what it reports back is what the user
 * ends up seeing: the page of lines, the directory listing, the missing-file suggestion, and the
 * refusal for a binary or an out-of-range offset.
 *
 * The Tauri filesystem boundary is mocked (there is no real filesystem in jsdom); everything
 * inside the helper — path handling, pagination, binary sniffing, formatting — runs for real.
 */

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

/** A file handle whose bytes look like text. */
function textFileHandle(): unknown {
    return {
        close: vi.fn(async () => undefined),
        read: vi.fn(async (buffer: Uint8Array) => {
            buffer[0] = 65;
            return 1;
        }),
    };
}

function linesOf(...lines: string[]): AsyncGenerator<string> {
    return (async function* () {
        for (const line of lines) {
            yield line;
        }
    })();
}

beforeEach(() => {
    vi.clearAllMocks();
    setLocale('en-US');
    readDirMock.mockResolvedValue([]);
    readTextFileLinesMock.mockResolvedValue(linesOf());
    statMock.mockResolvedValue({ isDirectory: false, size: 12 });
    openMock.mockResolvedValue(textFileHandle());
    createAttachmentMock.mockImplementation(async (type: string, path: string) => ({
        id: `${type}:${path}`,
        type,
        name: path.split(/[\\/]/).pop() ?? path,
        originPath: path,
        size: 1,
    }));
});

describe('user asks the assistant to read a text file', () => {
    it('user gets the file lines numbered so the model can cite them', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('first line', 'second line'));

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\notes.txt' },
            createExecutionContext()
        );

        expect(result.result).toContain('<path>C:\\tmp\\notes.txt</path>');
        expect(result.result).toContain('<type>file</type>');
        expect(result.result).toContain('1: first line');
        expect(result.result).toContain('2: second line');
        expect(result.result).toContain('(End of file - total 2 lines)');
    });

    it('user gets the page they asked for when they give an offset and a limit', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('one', 'two', 'three', 'four', 'five'));

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\notes.txt', offset: 2, limit: 2 },
            createExecutionContext()
        );

        expect(result.result).toContain('2: two');
        expect(result.result).toContain('3: three');
        expect(result.result).not.toContain('1: one');
        expect(result.result).not.toContain('4: four');
        expect(result.result).toContain('(Showing lines 2-3 of 5. Use offset=4 to continue.)');
    });

    it('user is told the offset is out of range when they ask past the end', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('only'));

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt', offset: 9 }, createExecutionContext())
        ).rejects.toThrow('Offset 9 is out of range for this file (1 lines)');
    });

    it('user gets an empty file reported as an empty read rather than an error', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf());

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\empty.txt' },
            createExecutionContext()
        );

        expect(result.result).toContain('<content>');
        expect(result.result).toContain('(End of file - total 0 lines)');
    });

    it('user gets a very long line shortened with a note so the answer stays readable', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('x'.repeat(2500)));

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\long.txt' },
            createExecutionContext()
        );

        expect(result.result).toContain('x'.repeat(2000));
        expect(result.result).toContain('... (line truncated to 2000 chars)');
        expect(result.result).not.toContain('x'.repeat(2001));
    });

    it('user gets the read stopped when they cancel the assistant', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('line'));
        const aborted = new AbortController();
        aborted.abort();

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt' }, createExecutionContext(aborted))
        ).rejects.toThrow('Request cancelled');
    });

    it('user is told the file is binary instead of getting garbage text', async () => {
        openMock.mockResolvedValueOnce({
            close: vi.fn(async () => undefined),
            read: vi.fn(async (buffer: Uint8Array) => {
                buffer[0] = 0;
                return 1;
            }),
        });

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\archive.bin' }, createExecutionContext())
        ).rejects.toThrow('Cannot read binary file: C:\\tmp\\archive.bin');
    });

    it('user gets a file with many control characters treated as binary', async () => {
        openMock.mockResolvedValueOnce({
            close: vi.fn(async () => undefined),
            read: vi.fn(async (buffer: Uint8Array) => {
                // Every sampled byte is a control character, so the sample is mostly non-printable.
                for (let index = 0; index < buffer.length; index += 1) {
                    buffer[index] = 1;
                }
                return buffer.length;
            }),
        });

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\control.bin' }, createExecutionContext())
        ).rejects.toThrow('Cannot read binary file');
    });

    it('user gets a file of ordinary tabs and newlines read as text', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('column\tvalue'));
        openMock.mockResolvedValueOnce({
            close: vi.fn(async () => undefined),
            read: vi.fn(async (buffer: Uint8Array) => {
                // Tab, newline and carriage return are printable whitespace, not binary.
                buffer[0] = 9;
                buffer[1] = 10;
                buffer[2] = 13;
                return 3;
            }),
        });

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\table.txt' },
            createExecutionContext()
        );

        expect(result.result).toContain('column\tvalue');
    });

    it('user gets an empty file treated as text without sniffing its bytes', async () => {
        statMock.mockResolvedValueOnce({ isDirectory: false, size: 0 });
        readTextFileLinesMock.mockResolvedValueOnce(linesOf());

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\empty.txt' },
            createExecutionContext()
        );

        expect(result.result).toContain('<type>file</type>');
        // An empty file has no bytes to sniff, so the handle is never opened.
        expect(openMock).not.toHaveBeenCalled();
    });

    it('user gets a file whose handle returns no bytes read as text', async () => {
        openMock.mockResolvedValueOnce({
            close: vi.fn(async () => undefined),
            read: vi.fn(async () => 0),
        });
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('content'));

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\odd.txt' },
            createExecutionContext()
        );

        expect(result.result).toContain('content');
    });

    it('user gets a file cut off when one page would exceed the output budget', async () => {
        // 30 lines of 2000 characters is well past the 50 KB page budget.
        readTextFileLinesMock.mockResolvedValueOnce(
            linesOf(...Array.from({ length: 30 }, () => 'y'.repeat(2000)))
        );

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\huge.txt', limit: 30 },
            createExecutionContext()
        );

        expect(result.result).toContain('(Output capped at 50 KB');
        expect(result.result).toContain('Use offset=');
    });

    it('user is told the file is missing and shown the closest names they might have meant', async () => {
        statMock.mockRejectedValueOnce(new Error('entry not found'));
        readDirMock.mockResolvedValueOnce([
            { name: 'notes.txt.bak' },
            { name: 'NOTES.txt' },
            { name: 'unrelated.md' },
            { name: 'notes.txt' },
        ]);

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt' }, createExecutionContext())
        ).rejects.toThrow(
            'File not found: C:\\tmp\\notes.txt\n\nDid you mean one of these?\nnotes.txt\nNOTES.txt\nnotes.txt.bak'
        );
    });

    it('user is told only that the file is missing when nothing similar exists', async () => {
        statMock.mockRejectedValueOnce(new Error('not found'));
        readDirMock.mockResolvedValueOnce([{ name: 'unrelated.md' }]);

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt' }, createExecutionContext())
        ).rejects.toThrow('File not found: C:\\tmp\\notes.txt');
    });

    it('user gets at most three suggestions so the message stays short', async () => {
        statMock.mockRejectedValueOnce(new Error('not found'));
        readDirMock.mockResolvedValueOnce(
            Array.from({ length: 8 }, (_value, index) => ({ name: `notes.txt.${index}` }))
        );

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt' }, createExecutionContext())
        ).rejects.toThrow(/notes\.txt\.0\nnotes\.txt\.1\nnotes\.txt\.2$/);
    });

    it('user is told only that the file is missing when its folder cannot be listed', async () => {
        statMock.mockRejectedValueOnce(new Error('not found'));
        readDirMock.mockRejectedValueOnce(new Error('access denied'));

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt' }, createExecutionContext())
        ).rejects.toThrow('File not found: C:\\tmp\\notes.txt');
    });

    it('user gets a non-missing filesystem failure passed through unchanged', async () => {
        statMock.mockRejectedValueOnce(new Error('permission denied'));

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt' }, createExecutionContext())
        ).rejects.toThrow('permission denied');
    });

    it('user gets a thrown string from the filesystem reported as the failure', async () => {
        statMock.mockRejectedValueOnce('disk offline');

        await expect(
            executeReadFile({ filePath: 'C:\\tmp\\notes.txt' }, createExecutionContext())
        ).rejects.toThrow('disk offline');
    });

    it('user gets a relative path resolved against their desktop', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('desktop file'));

        const result = await executeReadFile({ filePath: 'notes.txt' }, createExecutionContext());

        expect(result.result).toContain('<path>C:\\Users\\tester\\Desktop\\notes.txt</path>');
        expect(result.result).toContain('desktop file');
    });

    it('user gets the file read with the default page size when they give no limit', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('one', 'two'));

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\notes.txt' },
            createExecutionContext()
        );

        expect(result.result).toContain('1: one');
        expect(result.result).toContain('2: two');
        expect(result.result).toContain('total 2 lines');
    });
});

describe('user asks the assistant to read a folder', () => {
    it('user gets the folder entries sorted with folders and symlinks marked', async () => {
        statMock.mockResolvedValueOnce({ isDirectory: true, size: 0 });
        readDirMock.mockResolvedValueOnce([
            { name: 'b.txt', isDirectory: false, isSymlink: false },
            { name: 'a', isDirectory: true, isSymlink: false },
            { name: 'link', isDirectory: false, isSymlink: true },
        ]);

        const result = await executeReadFile({ filePath: 'C:\\tmp' }, createExecutionContext());

        expect(result.result).toContain('<type>directory</type>');
        expect(result.result).toContain('a/');
        expect(result.result).toContain('b.txt');
        expect(result.result).toContain('link@');
        expect(result.result).toContain('(3 entries)');
        // Sorted by name, so the folder marker and the symlink marker land in name order.
        expect(result.result.indexOf('a/')).toBeLessThan(result.result.indexOf('b.txt'));
        expect(result.result.indexOf('b.txt')).toBeLessThan(result.result.indexOf('link@'));
    });

    it('user gets the folder page they asked for with a pointer to the next one', async () => {
        statMock.mockResolvedValueOnce({ isDirectory: true, size: 0 });
        readDirMock.mockResolvedValueOnce([
            { name: 'c.txt', isDirectory: false, isSymlink: false },
            { name: 'a.txt', isDirectory: false, isSymlink: false },
            { name: 'b.txt', isDirectory: false, isSymlink: false },
        ]);

        const result = await executeReadFile(
            { filePath: 'C:\\tmp', offset: 2, limit: 1 },
            createExecutionContext()
        );

        expect(result.result).toContain('b.txt');
        expect(result.result).not.toContain('a.txt');
        expect(result.result).not.toContain('c.txt');
        expect(result.result).toContain('(Showing 1 of 3 entries. Use offset=3 to continue.)');
    });

    it('user gets an empty folder reported as empty rather than as an error', async () => {
        statMock.mockResolvedValueOnce({ isDirectory: true, size: 0 });
        readDirMock.mockResolvedValueOnce([]);

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\empty' },
            createExecutionContext()
        );

        expect(result.result).toContain('<entries>');
        expect(result.result).toContain('(0 entries)');
    });
});

describe('user asks the assistant to read a picture or a pdf', () => {
    it('user gets an image attached instead of having it forced into text', async () => {
        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\diagram.png' },
            createExecutionContext()
        );

        expect(result.result).toContain('<type>image</type>');
        expect(result.result).toContain('Image attached in tool result.');
        expect(result.attachments).toEqual([
            expect.objectContaining({ type: 'image', originPath: 'C:\\tmp\\diagram.png' }),
        ]);
    });

    it('user gets a pdf attached as a file so the model can read it', async () => {
        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\report.PDF' },
            createExecutionContext()
        );

        expect(result.result).toContain('<type>pdf</type>');
        expect(result.attachments).toEqual([
            expect.objectContaining({ type: 'file', originPath: 'C:\\tmp\\report.PDF' }),
        ]);
    });

    it('user gets every raster image format recognised as a picture', async () => {
        for (const extension of [
            'avif',
            'bmp',
            'gif',
            'ico',
            'jpeg',
            'jpg',
            'png',
            'tif',
            'tiff',
            'webp',
        ]) {
            const result = await executeReadFile(
                { filePath: `C:\\tmp\\picture.${extension}` },
                createExecutionContext()
            );

            expect(result.result, extension).toContain('<type>image</type>');
        }
    });

    it('user gets a folder named like a picture still read as a folder', async () => {
        statMock.mockResolvedValueOnce({ isDirectory: true, size: 0 });
        readDirMock.mockResolvedValueOnce([{ name: 'inner.png', isDirectory: false }]);

        const result = await executeReadFile(
            { filePath: 'C:\\tmp\\album.png' },
            createExecutionContext()
        );

        expect(result.result).toContain('<type>directory</type>');
    });

    it('user gets a text file with a dot in its folder name read as text', async () => {
        readTextFileLinesMock.mockResolvedValueOnce(linesOf('body'));

        const result = await executeReadFile(
            { filePath: 'C:\\my.folder\\notes' },
            createExecutionContext()
        );

        expect(result.result).toContain('<type>file</type>');
        expect(result.result).toContain('body');
    });
});

describe('user sees what the assistant is about to read', () => {
    it('user is asked to approve reading a file and told the exact path', async () => {
        const approval = await buildReadApprovalRequest({ filePath: 'C:\\tmp\\notes.txt' });

        expect(approval).toMatchObject({
            command: 'C:\\tmp\\notes.txt',
            title: 'Confirm local content read',
        });
        expect(approval?.reason).toContain('reads local file or directory contents');
    });

    it('user is asked to approve a relative path resolved to the full one', async () => {
        const approval = await buildReadApprovalRequest({ filePath: 'notes.txt' });

        expect(approval?.command).toBe('C:\\Users\\tester\\Desktop\\notes.txt');
    });

    it('user gets no approval prompt when the request is malformed', async () => {
        // Nothing to show and nothing to read, so the tool is rejected before any prompt.
        expect(await buildReadApprovalRequest({})).toBeNull();
        expect(await buildReadApprovalRequest({ filePath: '   ' })).toBeNull();
    });

    it('user sees the file name as the conversation target of a read', () => {
        expect(buildReadConversationSemantic({ filePath: 'C:\\deep\\folder\\notes.txt' })).toEqual({
            action: 'read',
            target: 'notes.txt',
        });
    });

    it('user sees a generic target when the read has no path yet', () => {
        expect(buildReadConversationSemantic({})).toEqual({
            action: 'read',
            target: 'local file',
        });
    });

    it('user sees a very long file name shortened in the conversation target', () => {
        const longName = `${'a'.repeat(200)}.txt`;
        const target = buildReadConversationSemantic({ filePath: `C:\\tmp\\${longName}` }).target;

        expect(target).toBeDefined();
        expect(target!.length).toBeLessThan(longName.length);
        expect(target!.endsWith('...')).toBe(true);
    });

    it('user sees the last segment of a path that ends with a separator', () => {
        expect(buildReadConversationSemantic({ filePath: 'C:\\tmp\\folder\\' })).toEqual({
            action: 'read',
            target: 'folder',
        });
    });
});
