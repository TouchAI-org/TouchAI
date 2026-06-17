import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClipboardPayload } from '@/services/NativeService/types';

const { readClipboardPayloadMock, createPersistedAttachmentFromDataMock } = vi.hoisted(() => ({
    readClipboardPayloadMock: vi.fn(),
    createPersistedAttachmentFromDataMock: vi.fn(),
}));

vi.mock('@/services/NativeService', () => ({
    native: {
        clipboard: {
            readClipboardPayload: readClipboardPayloadMock,
            consumeShortcutAutoPastePayload: vi.fn(),
            writeClipboardText: vi.fn(),
        },
    },
}));

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    createPersistedAttachmentFromData: createPersistedAttachmentFromDataMock,
}));

import { clipboardService } from '@/services/ClipboardService';

function createClipboardData(data: Record<string, string>): DataTransfer {
    return {
        getData: vi.fn((type: string) => data[type] ?? ''),
    } as unknown as DataTransfer;
}

function createClipboardDataWithFiles(
    data: Record<string, string>,
    files: File[],
    items?: Array<{ kind: string; getAsFile: () => File | null }>
): DataTransfer {
    return {
        getData: vi.fn((type: string) => data[type] ?? ''),
        files,
        items: items ?? [],
    } as unknown as DataTransfer;
}

function createNativePayload(overrides: Partial<ClipboardPayload>): ClipboardPayload {
    return {
        snapshotId: 'native-1',
        observedAt: 1,
        text: null,
        html: null,
        htmlSourceUrl: null,
        htmlImages: [],
        imagePaths: [],
        filePaths: [],
        fragments: [],
        ...overrides,
    };
}

describe('ClipboardService explicit paste', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createPersistedAttachmentFromDataMock.mockImplementation(
            async (input: { type: 'image' | 'file'; name: string }) => ({
                path: `D:/persisted/${input.name}`,
                type: input.type,
            })
        );
    });

    it('falls back to the paste event text when native clipboard reads fail', async () => {
        readClipboardPayloadMock.mockRejectedValue(new Error('clipboard busy'));

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardData({
                'text/plain': 'Line one\nLine two',
            })
        );

        expect(payload?.text).toBe('Line one\nLine two');
        expect(payload?.fragments).toEqual([{ type: 'text', text: 'Line one\nLine two' }]);
    });

    it('uses paste event table text as plain rows while keeping native attachments', async () => {
        readClipboardPayloadMock.mockResolvedValue(
            createNativePayload({
                imagePaths: ['D:/clip/image.png'],
                fragments: [{ type: 'image', path: 'D:/clip/image.png' }],
            })
        );

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardData({
                'text/plain': 'Name\tAge\nAlice\t28',
                'text/html':
                    '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>28</td></tr></table>',
            })
        );

        expect(payload?.text).toBe('Name\tAge\nAlice\t28');
        expect(payload?.imagePaths).toEqual(['D:/clip/image.png']);
        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'Name\tAge\nAlice\t28' },
            { type: 'image', path: 'D:/clip/image.png' },
        ]);
    });

    it('preserves explicit paste boundary whitespace from the browser paste event', async () => {
        readClipboardPayloadMock.mockRejectedValue(new Error('clipboard busy'));

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardData({
                'text/plain': '  keep me  ',
            })
        );

        expect(payload?.text).toBe('  keep me  ');
        expect(payload?.fragments).toEqual([{ type: 'text', text: '  keep me  ' }]);
    });

    it('falls back to persisted browser paste-event files when native clipboard reads fail', async () => {
        readClipboardPayloadMock.mockRejectedValue(new Error('clipboard busy'));
        const imageFile = new File([new Uint8Array([1, 2, 3])], 'pasted.png', {
            type: 'image/png',
        });

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardDataWithFiles(
                {
                    'text/plain': 'caption',
                    'text/html': '<p>caption</p><img src="blob:https://example.com/1">',
                },
                [imageFile],
                [{ kind: 'file', getAsFile: () => imageFile }]
            )
        );

        expect(createPersistedAttachmentFromDataMock).toHaveBeenCalledTimes(1);
        expect(payload?.imagePaths).toEqual(['D:/persisted/pasted.png']);
        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'caption' },
            { type: 'image', path: 'D:/persisted/pasted.png' },
        ]);
    });

    it('emits fragments for file-only browser paste-event attachments', async () => {
        readClipboardPayloadMock.mockRejectedValue(new Error('clipboard busy'));
        const file = new File([new Uint8Array([1, 2, 3])], 'report.pdf', {
            type: 'application/pdf',
        });

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardDataWithFiles({}, [file], [{ kind: 'file', getAsFile: () => file }])
        );

        expect(payload?.text).toBeNull();
        expect(payload?.filePaths).toEqual(['D:/persisted/report.pdf']);
        expect(payload?.fragments).toEqual([{ type: 'file', path: 'D:/persisted/report.pdf' }]);
    });
});
