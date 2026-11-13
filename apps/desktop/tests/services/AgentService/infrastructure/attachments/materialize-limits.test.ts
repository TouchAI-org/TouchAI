import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    readAttachmentAsBase64Mock,
    readAttachmentAsTextMock,
    readAttachmentImageForTransportMock,
    inspectAttachmentsMock,
} = vi.hoisted(() => ({
    readAttachmentAsBase64Mock: vi.fn(),
    readAttachmentAsTextMock: vi.fn(),
    readAttachmentImageForTransportMock: vi.fn(),
    inspectAttachmentsMock: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/attachments/content', () => ({
    readAttachmentAsBase64: readAttachmentAsBase64Mock,
    readAttachmentAsText: readAttachmentAsTextMock,
    readAttachmentImageForTransport: readAttachmentImageForTransportMock,
    formatAttachmentNotInlined: (reason: string, path: string) =>
        `[Not inlined: ${reason}. Local path: ${path}.]`,
    formatAttachmentAnchorText: () => 'anchor',
}));

vi.mock('@/services/AgentService/infrastructure/attachments/inspect', () => ({
    inspectAttachments: inspectAttachmentsMock,
}));

vi.mock('@/services/AgentService/infrastructure/attachments/support', () => ({
    isAttachmentSupported: vi.fn(() => true),
}));

import type { AttachmentInspection } from '@/services/AgentService/infrastructure/attachments/inspect';
import { buildAttachmentParts } from '@/services/AgentService/infrastructure/attachments/materialize';

function inspection(
    overrides: Partial<AttachmentInspection> & {
        name?: string;
        kind?: AttachmentInspection['kind'];
        size?: number;
        mimeType?: string;
    } = {}
): AttachmentInspection {
    const name = overrides.name ?? 'notes.txt';
    const kind = overrides.kind ?? 'text';
    const mimeType = overrides.mimeType ?? 'text/plain';
    const attachment = {
        id: name,
        type: kind === 'image' ? ('image' as const) : ('file' as const),
        name,
        path: `D:/${name}`,
        originPath: `D:/${name}`,
        size: overrides.size ?? 10,
        mimeType,
        supportStatus: 'supported' as const,
    };
    return {
        attachment,
        kind,
        mimeType,
        size: overrides.size ?? 10,
        semanticIntent:
            kind === 'image'
                ? 'visual-reference'
                : kind === 'directory'
                  ? 'directory-reference'
                  : 'textual-content',
        meta: {
            alias: 'A1',
            order: 0,
            type: attachment.type,
            name,
            mimeType,
            originPath: attachment.originPath,
            attachmentId: 1,
            hash: 'hash',
        },
        supportStatus: 'supported',
        ...overrides,
    } as AttachmentInspection;
}

beforeEach(() => {
    readAttachmentAsBase64Mock.mockReset();
    readAttachmentAsTextMock.mockReset();
    readAttachmentImageForTransportMock.mockReset();
    inspectAttachmentsMock.mockReset();
    readAttachmentAsBase64Mock.mockResolvedValue({
        data: 'JVBERi0=',
        mimeType: 'application/pdf',
    });
    readAttachmentAsTextMock.mockResolvedValue({
        content: 'hello',
        isBinary: false,
        truncated: false,
    });
    readAttachmentImageForTransportMock.mockResolvedValue({
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
    });
});

async function materialize(items: AttachmentInspection[]) {
    inspectAttachmentsMock.mockResolvedValue(items);
    return buildAttachmentParts(
        items.map((item) => item.attachment),
        { inlineFileContents: true }
    );
}

describe('given local attachments enter the request', () => {
    it('user referencing a file gets only its path by default', async () => {
        inspectAttachmentsMock.mockResolvedValue([inspection()]);

        const parts = await buildAttachmentParts([inspection().attachment]);
        const file = parts.find((part) => part.type === 'file');

        expect(readAttachmentAsTextMock).not.toHaveBeenCalled();
        if (file?.type !== 'file') throw new Error('missing file part');
        expect(file.textContent).toContain('file is referenced by path');
    });

    it('user referencing a PDF by path gets no document bytes', async () => {
        inspectAttachmentsMock.mockResolvedValue([
            inspection({ name: 'plan.pdf', kind: 'pdf', mimeType: 'application/pdf' }),
        ]);

        const parts = await buildAttachmentParts([inspection().attachment]);
        const file = parts.find((part) => part.type === 'file');

        expect(readAttachmentAsBase64Mock).not.toHaveBeenCalled();
        if (file?.type !== 'file') throw new Error('missing file part');
        expect(file.textContent).toContain('file is referenced by path');
        expect(file.base64Data).toBeUndefined();
    });

    it('user referencing a folder gets a directory path reference', async () => {
        inspectAttachmentsMock.mockResolvedValue([
            inspection({ name: 'docs', kind: 'directory', mimeType: 'application/x-directory' }),
        ]);

        const parts = await buildAttachmentParts([inspection().attachment]);
        const file = parts.find((part) => part.type === 'file');

        if (file?.type !== 'file') throw new Error('missing file part');
        expect(file.textContent).toContain('directory is referenced by path');
    });

    it('user with a large text file gets a bounded excerpt instead of the whole file', async () => {
        readAttachmentAsTextMock.mockResolvedValue({
            content: 'x'.repeat(120_000),
            isBinary: false,
            truncated: true,
        });

        const parts = await materialize([inspection()]);
        const file = parts.find((part) => part.type === 'file');

        expect(file?.type).toBe('file');
        if (file?.type !== 'file') throw new Error('missing file part');
        expect(file.textContent).toContain('Content truncated to 50000 characters');
        expect(file.textContent!.length).toBeLessThan(51_000);
        expect(file.base64Data).toBeUndefined();
    });

    it('user with many text files gets later files referenced by path after the shared budget is spent', async () => {
        readAttachmentAsTextMock.mockResolvedValue({
            content: 'x'.repeat(60_000),
            isBinary: false,
            truncated: true,
        });

        const parts = await materialize([
            inspection({ name: 'a.txt' }),
            inspection({ name: 'b.txt' }),
            inspection({ name: 'c.txt' }),
        ]);

        const files = parts.filter((part) => part.type === 'file');
        expect(files).toHaveLength(2);
        const referenced = parts.find(
            (part) => part.type === 'text' && part.text.includes('D:/c.txt')
        );
        expect(referenced?.type === 'text' ? referenced.text : '').toContain(
            'the text budget for this message is exhausted'
        );
    });

    it('user attaching a binary file gets its path, never base64 content', async () => {
        readAttachmentAsTextMock.mockResolvedValue({
            content: '',
            isBinary: true,
            truncated: false,
        });

        const parts = await materialize([inspection({ name: 'archive.zip' })]);
        const file = parts.find((part) => part.type === 'file');

        if (file?.type !== 'file') throw new Error('missing file part');
        expect(file.kind).toBe('binary');
        expect(file.base64Data).toBeUndefined();
        expect(file.textContent).toContain('binary content');
    });

    it('user attaching an oversized PDF gets a path reference without reading it', async () => {
        const parts = await materialize([
            inspection({
                name: 'big.pdf',
                kind: 'pdf',
                mimeType: 'application/pdf',
                size: 9 * 1024 * 1024,
            }),
        ]);
        const file = parts.find((part) => part.type === 'file');

        if (file?.type !== 'file') throw new Error('missing file part');
        expect(file.base64Data).toBeUndefined();
        expect(file.textContent).toContain('the PDF exceeds the inline transport limit');
        expect(readAttachmentAsBase64Mock).not.toHaveBeenCalled();
    });

    it('user attaching a readable PDF keeps it as an inline document', async () => {
        const parts = await materialize([
            inspection({
                name: 'small.pdf',
                kind: 'pdf',
                mimeType: 'application/pdf',
                size: 1_000,
            }),
        ]);
        const file = parts.find((part) => part.type === 'file');

        if (file?.type !== 'file') throw new Error('missing file part');
        expect(file.base64Data).toBe('JVBERi0=');
    });

    it('user attaching an image too large to normalize gets a path reference instead of empty image data', async () => {
        readAttachmentImageForTransportMock.mockResolvedValue({
            data: 'A'.repeat(4_500_001),
            mimeType: 'image/png',
        });

        const parts = await materialize([
            inspection({ name: 'huge.png', kind: 'image', mimeType: 'image/png' }),
        ]);

        expect(parts.some((part) => part.type === 'image')).toBe(false);
        const text = parts.find((part) => part.type === 'text' && part.text.includes('image'));
        expect(text?.type === 'text' ? text.text : '').toContain(
            'the image exceeds the inline transport limit'
        );
    });
});

describe('given multiple PDFs share one request', () => {
    it('user gets later PDFs referenced by path after the shared PDF budget is spent', async () => {
        readAttachmentAsBase64Mock.mockResolvedValue({
            data: 'x'.repeat(9_000_000),
            mimeType: 'application/pdf',
        });

        const parts = await materialize([
            inspection({ name: 'a.pdf', kind: 'pdf', mimeType: 'application/pdf', size: 1000 }),
            inspection({ name: 'b.pdf', kind: 'pdf', mimeType: 'application/pdf', size: 1000 }),
            inspection({ name: 'c.pdf', kind: 'pdf', mimeType: 'application/pdf', size: 1000 }),
        ]);

        expect(parts.filter((part) => part.type === 'file')).toHaveLength(2);
        const referenced = parts.find(
            (part) => part.type === 'text' && part.text.includes('D:/c.pdf')
        );
        expect(referenced?.type === 'text' ? referenced.text : '').toContain(
            'the PDF budget for this message is exhausted'
        );
    });
});
