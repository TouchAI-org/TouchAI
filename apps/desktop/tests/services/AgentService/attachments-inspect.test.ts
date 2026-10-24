import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments/types';

/**
 * Attachments are classified from the file name and the MIME type the OS reported, and the
 * classification decides how the model sees them. These tests drive the public entry point
 * with real file names so the rule is pinned to what a user attaches, not to an internal
 * helper.
 */
const contentState = vi.hoisted(() => ({
    readAttachmentBuffer: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/attachments/content', async () => {
    const actual = await vi.importActual<
        typeof import('@/services/AgentService/infrastructure/attachments/content')
    >('@/services/AgentService/infrastructure/attachments/content');

    return { ...actual, readAttachmentBuffer: contentState.readAttachmentBuffer };
});

const { inspectAttachment, inspectAttachments } =
    await import('@/services/AgentService/infrastructure/attachments/inspect');

function attachment(overrides: Partial<AttachmentIndex> = {}): AttachmentIndex {
    return {
        id: 'att-1',
        type: 'file',
        name: 'notes.txt',
        path: '/tmp/notes.txt',
        ...overrides,
    } as AttachmentIndex;
}

/** A buffer of UTF-8 text, which the binary sniff should accept. */
function textBuffer(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

beforeEach(() => {
    contentState.readAttachmentBuffer.mockReset();
    contentState.readAttachmentBuffer.mockResolvedValue(textBuffer('hello world'));
});

describe('user attaches an image', () => {
    it('user gets the image kind from an image MIME type', async () => {
        const result = await inspectAttachment(
            attachment({ name: 'photo.png', mimeType: 'image/png' }),
            0
        );

        expect(result.kind).toBe('image');
        expect(result.semanticIntent).toBe('visual-reference');
    });

    it('user gets the image kind from an image attachment type even without a MIME type', async () => {
        const result = await inspectAttachment(
            attachment({ type: 'image', name: 'clipboard.png' }),
            0
        );

        expect(result.kind).toBe('image');
        // The MIME type is inferred so the model is told what it received.
        expect(result.mimeType).toBe('image/png');
    });
});

describe('user attaches a document', () => {
    it('user gets the pdf kind from a pdf MIME type', async () => {
        const result = await inspectAttachment(
            attachment({ name: 'report', mimeType: 'application/pdf' }),
            0
        );

        expect(result.kind).toBe('pdf');
        expect(result.semanticIntent).toBe('document-content');
    });

    it('user gets the pdf kind from a pdf extension without a MIME type', async () => {
        const result = await inspectAttachment(attachment({ name: 'report.PDF' }), 0);

        expect(result.kind).toBe('pdf');
    });

    it('user gets the directory kind for a directory attachment', async () => {
        const result = await inspectAttachment(
            attachment({ name: 'project', mimeType: 'application/x-directory' }),
            0
        );

        expect(result.kind).toBe('directory');
        expect(result.semanticIntent).toBe('directory-reference');
    });
});

describe('user attaches a structured text file', () => {
    it('user gets the structured-text kind from a json extension', async () => {
        const result = await inspectAttachment(attachment({ name: 'config.json' }), 0);

        expect(result.kind).toBe('structured-text');
        expect(result.semanticIntent).toBe('textual-content');
    });

    it('user gets the structured-text kind from a csv MIME type', async () => {
        const result = await inspectAttachment(
            attachment({ name: 'data', mimeType: 'text/csv' }),
            0
        );

        expect(result.kind).toBe('structured-text');
    });

    it('user gets the structured-text kind from a yaml extension', async () => {
        const result = await inspectAttachment(attachment({ name: 'ci.yml' }), 0);

        expect(result.kind).toBe('structured-text');
    });
});

describe('user attaches source code', () => {
    it('user gets the code kind from a known code extension', async () => {
        const result = await inspectAttachment(attachment({ name: 'main.rs' }), 0);

        expect(result.kind).toBe('code');
    });

    it('user gets the code kind from a code extension with a generic text MIME type', async () => {
        const result = await inspectAttachment(
            attachment({ name: 'script.py', mimeType: 'text/plain' }),
            0
        );

        expect(result.kind).toBe('code');
    });
});

describe('user attaches plain text', () => {
    it('user gets the text kind from a text MIME type', async () => {
        const result = await inspectAttachment(
            attachment({ name: 'notes', mimeType: 'text/plain' }),
            0
        );

        expect(result.kind).toBe('text');
    });

    it('user gets the text kind from a plain text extension', async () => {
        const result = await inspectAttachment(attachment({ name: 'readme.md' }), 0);

        expect(result.kind).toBe('text');
    });

    it('user gets a name without an extension classified by its MIME type', async () => {
        const result = await inspectAttachment(
            attachment({ name: 'LICENSE', mimeType: 'text/plain' }),
            0
        );

        expect(result.kind).toBe('text');
    });
});

describe('user attaches a file the name does not explain', () => {
    it('user gets the binary kind when the content is not text', async () => {
        contentState.readAttachmentBuffer.mockResolvedValue(
            new Uint8Array([0x00, 0x01, 0x02, 0x00]).buffer
        );

        const result = await inspectAttachment(attachment({ name: 'blob' }), 0);

        expect(result.kind).toBe('binary');
        expect(result.semanticIntent).toBe('binary-content');
    });

    it('user gets the text kind when an unknown extension holds text', async () => {
        const result = await inspectAttachment(attachment({ name: 'data.unknownext' }), 0);

        expect(result.kind).toBe('text');
    });

    it('user gets the binary kind when the file is mostly replacement characters', async () => {
        // A high share of undecodable bytes is the signature of a binary payload.
        contentState.readAttachmentBuffer.mockResolvedValue(
            textBuffer('\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD')
        );

        const result = await inspectAttachment(attachment({ name: 'mystery' }), 0);

        expect(result.kind).toBe('binary');
    });
});

describe('user attaches several files at once', () => {
    it('user gets every file classified in the order they were attached', async () => {
        const results = await inspectAttachments([
            attachment({ id: 'a', name: 'photo.png', mimeType: 'image/png' }),
            attachment({ id: 'b', name: 'notes.txt' }),
            attachment({ id: 'c', name: 'report.pdf' }),
        ]);

        expect(results.map((result) => result.kind)).toEqual(['image', 'text', 'pdf']);
    });

    it('user gets the attachment size and support status carried through', async () => {
        const results = await inspectAttachments([
            attachment({ id: 'a', name: 'notes.txt', size: 42, supportStatus: 'supported' }),
        ]);

        expect(results[0]!.size).toBe(42);
        expect(results[0]!.supportStatus).toBe('supported');
    });

    it('user gets null size and support status when the index has none', async () => {
        const results = await inspectAttachments([attachment({ name: 'notes.txt' })]);

        expect(results[0]!.size).toBeNull();
        expect(results[0]!.supportStatus).toBeNull();
    });
});
