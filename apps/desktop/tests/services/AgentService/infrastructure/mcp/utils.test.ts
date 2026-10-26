import type { McpToolCallResponse } from '@services/NativeService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import {
    extractMcpToolAttachments,
    formatMcpToolResponse,
    localizeNativeMcpTimeoutError,
    normalizeErrorMessage,
    raceWithTimeoutAndSignal,
    readOptionalMcpArgs,
    readOptionalMcpRecord,
} from '@/services/AgentService/infrastructure/mcp/utils';

/**
 * MCP servers hand back opaque content blocks. Turning them into text and attachments is what
 * makes a third-party tool usable from the conversation, so the observable contract is: the text
 * the model reads, the files the user gets, and the error the user sees.
 */

const { createPersistedAttachmentFromDataMock } = vi.hoisted(() => ({
    createPersistedAttachmentFromDataMock: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/attachments', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('@/services/AgentService/infrastructure/attachments')
    >()),
    createPersistedAttachmentFromData: createPersistedAttachmentFromDataMock,
}));

function response(content: McpToolCallResponse['content']): McpToolCallResponse {
    return { success: true, content, is_error: false };
}

/** Base64 for the four bytes 1, 2, 3, 4. */
const SAMPLE_BASE64 = 'AQIDBA==';

beforeEach(() => {
    setLocale('en-US');
    createPersistedAttachmentFromDataMock.mockReset();
    createPersistedAttachmentFromDataMock.mockImplementation(
        async (options: { name: string; originPath: string; type: string }) => ({
            id: 'attachment-1',
            type: options.type,
            path: `D:/cache/${options.name}`,
            originPath: options.originPath,
            name: options.name,
        })
    );
});

afterEach(() => {
    vi.useRealTimers();
});

describe('user gets the text out of an MCP tool result', () => {
    it('user gets every text block joined in the order the server sent them', () => {
        const result = formatMcpToolResponse(
            response([
                { type: 'text', text: 'first line' },
                { type: 'text', text: 'second line' },
            ])
        );

        expect(result).toBe('first line\nsecond line');
    });

    it('user gets an empty block kept as a blank line instead of losing the layout', () => {
        const result = formatMcpToolResponse(
            response([
                { type: 'text', text: '' },
                { type: 'text', text: 'after blank' },
            ])
        );

        expect(result).toBe('\nafter blank');
    });

    it('user gets an image described by its media type instead of raw base64', () => {
        const result = formatMcpToolResponse(
            response([{ type: 'image', mime_type: 'image/png', data: SAMPLE_BASE64 }])
        );

        expect(result).toBe('[Image: image/png]');
        expect(result).not.toContain(SAMPLE_BASE64);
    });

    it('user gets an image with no media type described as unknown', () => {
        expect(formatMcpToolResponse(response([{ type: 'image', data: SAMPLE_BASE64 }]))).toBe(
            '[Image: unknown]'
        );
    });

    it('user gets a resource described by its own text when the server sent one', () => {
        const result = formatMcpToolResponse(
            response([{ type: 'resource', uri: 'file:///tmp/report.pdf', text: 'report body' }])
        );

        expect(result).toBe('report body');
    });

    it('user gets a resource described by its address when it carries no text', () => {
        const result = formatMcpToolResponse(
            response([{ type: 'resource', uri: 'file:///tmp/report.pdf' }])
        );

        expect(result).toBe('[Resource: file:///tmp/report.pdf]');
    });

    it('user gets a resource with no address described as unknown', () => {
        expect(formatMcpToolResponse(response([{ type: 'resource' }]))).toBe('[Resource: unknown]');
    });

    it('user gets a content kind the app does not know skipped without failing the call', () => {
        const result = formatMcpToolResponse(
            response([
                { type: 'text', text: 'before' },
                { type: 'audio' as never, text: 'noise' },
                { type: 'text', text: 'after' },
            ])
        );

        expect(result).toBe('before\n\nafter');
    });

    it('user gets an empty result when the server returned no content', () => {
        expect(formatMcpToolResponse(response([]))).toBe('');
    });

    it('user reads the image and resource placeholders in their own language', () => {
        setLocale('zh-CN');

        const result = formatMcpToolResponse(
            response([
                { type: 'image', mime_type: 'image/png' },
                { type: 'resource', uri: 'x' },
            ])
        );

        expect(result).toBe('[图片：image/png]\n[资源：x]');
    });
});

describe('user gets MCP server arguments and environment read from storage', () => {
    it('user gets the saved arguments when the server has some', () => {
        expect(readOptionalMcpArgs('["--verbose","--port","8080"]')).toEqual([
            '--verbose',
            '--port',
            '8080',
        ]);
    });

    it('user gets no arguments at all when nothing was saved', () => {
        expect(readOptionalMcpArgs(null)).toBeUndefined();
        expect(readOptionalMcpArgs('[]')).toBeUndefined();
    });

    it('user gets the saved environment variables when the server has some', () => {
        expect(readOptionalMcpRecord('{"API_KEY":"secret","MODE":"prod"}')).toEqual({
            API_KEY: 'secret',
            MODE: 'prod',
        });
    });

    it('user gets no environment at all when nothing was saved', () => {
        expect(readOptionalMcpRecord(undefined)).toBeUndefined();
        expect(readOptionalMcpRecord('{}')).toBeUndefined();
    });

    it('user gets broken stored JSON treated as empty instead of crashing the server list', () => {
        expect(readOptionalMcpArgs('not json')).toBeUndefined();
        expect(readOptionalMcpRecord('{"unterminated":')).toBeUndefined();
    });
});

describe('user is shown a meaningful message when an MCP tool fails', () => {
    it('user gets the message of a real error', () => {
        expect(normalizeErrorMessage(new Error('connection refused'))).toBe('connection refused');
    });

    it('user gets a thrown string shown as it was thrown', () => {
        expect(normalizeErrorMessage('plain string failure')).toBe('plain string failure');
    });

    it('user gets a thrown object shown as text rather than nothing', () => {
        expect(normalizeErrorMessage({ code: 42 })).toBe('[object Object]');
    });

    it('user gets the native timeout translated into their own language', () => {
        const error = localizeNativeMcpTimeoutError(
            new Error('Tool execution timed out (5000ms)'),
            5000
        );

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Tool execution timed out (5000ms)');
    });

    it('user gets the native timeout shown with the configured limit, not the native text', () => {
        setLocale('zh-CN');

        const error = localizeNativeMcpTimeoutError(
            new Error('Tool execution timed out (5000ms)'),
            30_000
        );

        expect(error.message).toBe('工具执行超时（30000ms）');
    });

    it('user gets any other native failure passed through unchanged', () => {
        const original = new Error('server crashed');

        expect(localizeNativeMcpTimeoutError(original, 5000)).toBe(original);
    });

    it('user gets a non-error native failure wrapped so it can be shown', () => {
        const localized = localizeNativeMcpTimeoutError('boom', 5000);

        expect(localized).toBeInstanceOf(Error);
        expect(localized.message).toBe('boom');
    });

    it('user gets a native timeout text with a non-numeric limit left alone', () => {
        const original = new Error('Tool execution timed out (soon)');

        expect(localizeNativeMcpTimeoutError(original, 5000)).toBe(original);
    });
});

describe('user is not kept waiting forever by an MCP tool', () => {
    it('user gets the tool result when it arrives in time', async () => {
        vi.useFakeTimers();

        const pending = raceWithTimeoutAndSignal(Promise.resolve('result'), 5000);
        await vi.advanceTimersByTimeAsync(0);

        await expect(pending).resolves.toBe('result');
    });

    it('user is told the tool timed out when it runs past its limit', async () => {
        vi.useFakeTimers();

        const pending = raceWithTimeoutAndSignal(new Promise(() => undefined), 1000);
        const assertion = expect(pending).rejects.toThrow('Tool execution timed out (1000ms)');
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
    });

    it('user is told the configured limit rather than the guard deadline', async () => {
        vi.useFakeTimers();

        const pending = raceWithTimeoutAndSignal(
            new Promise(() => undefined),
            6000,
            undefined,
            5000
        );
        const assertion = expect(pending).rejects.toThrow('5000ms');
        await vi.advanceTimersByTimeAsync(6000);
        await assertion;
    });

    it('user gets the tool failure passed through instead of a timeout', async () => {
        vi.useFakeTimers();

        const pending = raceWithTimeoutAndSignal(Promise.reject(new Error('tool blew up')), 5000);
        const assertion = expect(pending).rejects.toThrow('tool blew up');
        await vi.advanceTimersByTimeAsync(0);
        await assertion;
    });

    it('user is told the call was cancelled when they stop it before it starts', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            raceWithTimeoutAndSignal(Promise.resolve('result'), 5000, controller.signal)
        ).rejects.toThrow('Request cancelled');
    });

    it('user gets the finished tool result even when they stop the assistant afterwards', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();

        const pending = raceWithTimeoutAndSignal(
            Promise.resolve('result'),
            5000,
            controller.signal
        );
        await vi.advanceTimersByTimeAsync(0);
        await expect(pending).resolves.toBe('result');

        // Stopping the assistant after the tool already answered must not turn the answer into
        // a cancellation for a call that no longer exists.
        controller.abort();
        expect(controller.signal.aborted).toBe(true);
    });

    it('user is told the call was cancelled when they stop it while it runs', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();

        let rejectTool: ((error: Error) => void) | undefined;
        const toolPromise = new Promise<string>((resolve) => {
            rejectTool = () => resolve('cancelled');
        });
        void rejectTool;

        const pending = raceWithTimeoutAndSignal(toolPromise, 60_000, controller.signal);
        controller.abort();

        await expect(pending).rejects.toThrow('Request cancelled');
    });

    it('user gets no timer left running after the tool finished', async () => {
        vi.useFakeTimers();

        const pending = raceWithTimeoutAndSignal(Promise.resolve('result'), 5000);
        await vi.advanceTimersByTimeAsync(0);
        await pending;

        // Only the tool's own result raced; a leftover timeout would keep the timer count up.
        expect(vi.getTimerCount()).toBe(0);
    });

    it('user gets the tool promise itself when no timeout and no cancellation was configured', async () => {
        const toolPromise = Promise.resolve('result');

        expect(raceWithTimeoutAndSignal(toolPromise, 0)).toBe(toolPromise);
    });

    it('user is still cut off when a timeout was configured without any cancellation', async () => {
        vi.useFakeTimers();

        const pending = raceWithTimeoutAndSignal(new Promise(() => undefined), 1000);
        const assertion = expect(pending).rejects.toThrow('Tool execution timed out (1000ms)');
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
    });

    it('user gets the tool result when the server disabled timeouts but cancellation stays wired', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();

        // No timer is armed at all, so settling must still clean up without looking for one.
        const pending = raceWithTimeoutAndSignal(Promise.resolve('result'), 0, controller.signal);

        await expect(pending).resolves.toBe('result');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('user is not cut off early by a timeout longer than a browser timer can express', async () => {
        vi.useFakeTimers();

        const pending = raceWithTimeoutAndSignal(new Promise(() => undefined), 2_147_483_648);
        const settled = vi.fn();
        void pending.then(settled, settled);

        await vi.advanceTimersByTimeAsync(2_147_483_647);
        expect(settled).not.toHaveBeenCalled();

        pending.catch(() => undefined);
    });

    it('user gets the tool result only once when the tool finishes just before the deadline', async () => {
        vi.useFakeTimers();
        let finish: ((value: string) => void) | undefined;
        const toolPromise = new Promise<string>((resolve) => {
            finish = resolve;
        });

        const pending = raceWithTimeoutAndSignal(toolPromise, 1000);
        finish?.('done');
        await vi.advanceTimersByTimeAsync(0);
        await expect(pending).resolves.toBe('done');

        // The timer must be cleared, otherwise a second settle would try to reject a settled promise.
        await vi.advanceTimersByTimeAsync(2000);
    });
});

describe('user gets the images and files an MCP tool produced', () => {
    it('user gets an image block saved as an image attachment with its bytes', async () => {
        const attachments = await extractMcpToolAttachments(
            response([{ type: 'image', mime_type: 'image/png', data: SAMPLE_BASE64 }]),
            { toolCallId: 'call-1', toolName: 'screenshot' }
        );

        expect(attachments).toHaveLength(1);
        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'image',
                name: 'tool-image-1.png',
                mimeType: 'image/png',
                size: 4,
                originPath: 'mcp://tool-result/screenshot/call-1/image-1',
            })
        );
        expect(
            Array.from(createPersistedAttachmentFromDataMock.mock.calls[0]![0].data as Uint8Array)
        ).toEqual([1, 2, 3, 4]);
    });

    it('user gets an image block with no bytes skipped instead of saved as an empty file', async () => {
        const attachments = await extractMcpToolAttachments(
            response([{ type: 'image', mime_type: 'image/png' }]),
            { toolCallId: 'call-1', toolName: 'screenshot' }
        );

        expect(attachments).toEqual([]);
        expect(createPersistedAttachmentFromDataMock).not.toHaveBeenCalled();
    });

    it('user gets an image with no media type named by its position', async () => {
        await extractMcpToolAttachments(
            response([
                { type: 'text', text: 'intro' },
                { type: 'image', data: SAMPLE_BASE64 },
            ]),
            { toolCallId: 'call-1', toolName: 'screenshot' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'tool-image-2' })
        );
    });

    it('user gets a resource file saved as a file attachment addressed by its own uri', async () => {
        await extractMcpToolAttachments(
            response([
                {
                    type: 'resource',
                    uri: 'file:///tmp/reports/q3.pdf',
                    mime_type: 'application/pdf',
                    blob: SAMPLE_BASE64,
                },
            ]),
            { toolCallId: 'call-1', toolName: 'read_report' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'file',
                name: 'q3.pdf',
                mimeType: 'application/pdf',
                originPath: 'file:///tmp/reports/q3.pdf',
                size: 4,
            })
        );
    });

    it('user gets a resource image saved as an image attachment', async () => {
        await extractMcpToolAttachments(
            response([
                {
                    type: 'resource',
                    uri: 'file:///tmp/chart.png',
                    mime_type: 'image/png',
                    blob: SAMPLE_BASE64,
                },
            ]),
            { toolCallId: 'call-1', toolName: 'chart' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'image', name: 'chart.png' })
        );
    });

    it('user gets a resource with no media type recognised from its file extension', async () => {
        await extractMcpToolAttachments(
            response([{ type: 'resource', uri: 'file:///tmp/photo.png', blob: SAMPLE_BASE64 }]),
            { toolCallId: 'call-1', toolName: 'gallery' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'image', mimeType: 'image/png', name: 'photo.png' })
        );
    });

    it('user gets a resource with an unknown extension saved as a plain file', async () => {
        await extractMcpToolAttachments(
            response([{ type: 'resource', uri: 'file:///tmp/data.bin', blob: SAMPLE_BASE64 }]),
            { toolCallId: 'call-1', toolName: 'export' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'file', mimeType: undefined, name: 'data.bin' })
        );
    });

    it('user gets a resource whose address ends in a dot saved as a plain file', async () => {
        await extractMcpToolAttachments(
            response([{ type: 'resource', uri: 'file:///tmp/notes.', blob: SAMPLE_BASE64 }]),
            { toolCallId: 'call-1', toolName: 'export' }
        );

        // A trailing dot leaves an empty extension, so no media type can be inferred from it.
        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'file', mimeType: undefined, name: 'notes.' })
        );
    });

    it('user gets a resource with an unparseable address ending in a dot saved as a plain file', async () => {
        await extractMcpToolAttachments(
            response([{ type: 'resource', uri: 'not a uri/archive.', blob: SAMPLE_BASE64 }]),
            { toolCallId: 'call-1', toolName: 'export' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'file', mimeType: undefined, name: 'archive.' })
        );
    });

    it('user gets a resource with no address saved under a synthetic path', async () => {
        await extractMcpToolAttachments(
            response([{ type: 'resource', mime_type: 'application/pdf', blob: SAMPLE_BASE64 }]),
            { toolCallId: 'call-9', toolName: 'export' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'tool-file-1.pdf',
                originPath: 'mcp://tool-result/export/call-9/file-1',
            })
        );
    });

    it('user gets a resource with no address and no media type named by its position', async () => {
        await extractMcpToolAttachments(response([{ type: 'resource', blob: SAMPLE_BASE64 }]), {
            toolCallId: 'call-1',
            toolName: 'export',
        });

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'file',
                name: 'tool-file-1',
                originPath: 'mcp://tool-result/export/call-1/file-1',
            })
        );
    });

    it('user gets a resource block with no bytes skipped instead of saved as an empty file', async () => {
        const attachments = await extractMcpToolAttachments(
            response([{ type: 'resource', uri: 'file:///tmp/empty.pdf' }]),
            { toolCallId: 'call-1', toolName: 'export' }
        );

        expect(attachments).toEqual([]);
    });

    it('user gets a text block producing no attachment at all', async () => {
        const attachments = await extractMcpToolAttachments(
            response([{ type: 'text', text: 'just words' }]),
            { toolCallId: 'call-1', toolName: 'search' }
        );

        expect(attachments).toEqual([]);
        expect(createPersistedAttachmentFromDataMock).not.toHaveBeenCalled();
    });

    it('user gets several attachments in the order the server sent them', async () => {
        await extractMcpToolAttachments(
            response([
                { type: 'image', mime_type: 'image/png', data: SAMPLE_BASE64 },
                { type: 'text', text: 'caption' },
                { type: 'image', mime_type: 'image/gif', data: SAMPLE_BASE64 },
                { type: 'resource', uri: 'file:///tmp/doc.pdf', blob: SAMPLE_BASE64 },
            ]),
            { toolCallId: 'call-7', toolName: 'gallery' }
        );

        expect(
            createPersistedAttachmentFromDataMock.mock.calls.map((call) => call[0].name)
        ).toEqual(['tool-image-1.png', 'tool-image-3.gif', 'doc.pdf']);
    });

    it('user gets a file name from a uri whose path ends without a file name', async () => {
        await extractMcpToolAttachments(
            response([{ type: 'resource', uri: 'file:///tmp/exports/', blob: SAMPLE_BASE64 }]),
            { toolCallId: 'call-1', toolName: 'export' }
        );

        // With no usable file name the attachment is named after its position and the mime map
        // cannot help because there is no extension, so the raw uri's last segment is used.
        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ originPath: 'file:///tmp/exports/' })
        );
        expect(createPersistedAttachmentFromDataMock.mock.calls[0]![0].name).not.toBe('');
    });

    it('user gets an attachment named from a uri that is not a valid web address', async () => {
        await extractMcpToolAttachments(
            response([{ type: 'resource', uri: 'not a uri/notes.txt', blob: SAMPLE_BASE64 }]),
            { toolCallId: 'call-1', toolName: 'export' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'notes.txt', type: 'file' })
        );
    });

    it('user gets an attachment named from a mime type when the uri is unreadable', async () => {
        await extractMcpToolAttachments(
            response([
                { type: 'resource', uri: '/', mime_type: 'image/webp', blob: SAMPLE_BASE64 },
            ]),
            { toolCallId: 'call-1', toolName: 'export' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'tool-file-1.webp', mimeType: 'image/webp' })
        );
    });

    it('user gets a resource uri with an upper-case extension recognised', async () => {
        await extractMcpToolAttachments(
            response([{ type: 'resource', uri: 'file:///tmp/SCAN.PNG', blob: SAMPLE_BASE64 }]),
            { toolCallId: 'call-1', toolName: 'scan' }
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'image', mimeType: 'image/png' })
        );
    });
});
