import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    readAttachmentAsBase64Mock,
    readAttachmentAsTextMock,
    readAttachmentImageForTransportMock,
    inspectAttachmentsMock,
    formatAttachmentNotInlinedMock,
} = vi.hoisted(() => ({
    readAttachmentAsBase64Mock: vi.fn(),
    readAttachmentAsTextMock: vi.fn(),
    readAttachmentImageForTransportMock: vi.fn(),
    inspectAttachmentsMock: vi.fn(),
    formatAttachmentNotInlinedMock: vi.fn(
        (reason: string, path: string) => `[Not inlined: ${reason}. Local path: ${path}.]`
    ),
}));

vi.mock('@/services/AgentService/infrastructure/attachments/content', () => ({
    readAttachmentAsBase64: readAttachmentAsBase64Mock,
    readAttachmentAsText: readAttachmentAsTextMock,
    readAttachmentImageForTransport: readAttachmentImageForTransportMock,
    formatAttachmentNotInlined: formatAttachmentNotInlinedMock,
    formatAttachmentAnchorText: vi.fn(() => 'anchor'),
}));

vi.mock('@/services/AgentService/infrastructure/attachments/inspect', () => ({
    inspectAttachments: inspectAttachmentsMock,
}));

vi.mock('@/services/AgentService/infrastructure/attachments/support', () => ({
    isAttachmentSupported: vi.fn(() => true),
}));

import { buildAttachmentParts } from '@/services/AgentService/infrastructure/attachments/materialize';

function createAttachment(id: string) {
    return {
        id,
        type: 'image' as const,
        name: `${id}.png`,
        path: `D:/${id}.png`,
        originPath: `D:/${id}.png`,
        supportStatus: 'supported' as const,
    };
}

describe('attachment materialization', () => {
    beforeEach(() => {
        readAttachmentAsBase64Mock.mockReset();
        readAttachmentAsTextMock.mockReset();
        readAttachmentImageForTransportMock.mockReset();
        inspectAttachmentsMock.mockReset();

        readAttachmentAsBase64Mock.mockResolvedValue({ data: 'base64', mimeType: 'image/png' });
        readAttachmentAsTextMock.mockResolvedValue({
            content: 'text',
            isBinary: false,
            truncated: false,
        });
        readAttachmentImageForTransportMock.mockResolvedValue({
            data: 'base64',
            mimeType: 'image/png',
        });
    });

    it('reads each attachment source only once per materialization', async () => {
        const attachments = [createAttachment('a'), createAttachment('a')];
        inspectAttachmentsMock.mockResolvedValue(
            attachments.map((attachment, index) => ({
                attachment,
                kind: 'image',
                mimeType: 'image/png',
                size: 10,
                semanticIntent: 'visual-reference',
                meta: { index },
            }))
        );

        await buildAttachmentParts(attachments);

        // 同一个源路径只解码一次，避免重复大文件读取。
        expect(readAttachmentImageForTransportMock).toHaveBeenCalledTimes(1);
        expect(readAttachmentImageForTransportMock).toHaveBeenCalledWith(
            expect.objectContaining({ path: 'D:/a.png' })
        );
    });

    it('still reads distinct attachments separately', async () => {
        const attachments = [createAttachment('a'), createAttachment('b')];
        inspectAttachmentsMock.mockResolvedValue(
            attachments.map((attachment, index) => ({
                attachment,
                kind: 'image',
                mimeType: 'image/png',
                size: 10,
                semanticIntent: 'visual-reference',
                meta: { index },
            }))
        );

        await buildAttachmentParts(attachments);

        expect(readAttachmentImageForTransportMock).toHaveBeenCalledTimes(2);
    });

    it('user keeps readable attachments when one source cannot be read', async () => {
        const attachments = [
            createAttachment('missing'),
            createAttachment('missing'),
            createAttachment('ok'),
        ];
        inspectAttachmentsMock.mockResolvedValue(
            attachments.map((attachment) => ({
                attachment,
                kind: 'image',
                mimeType: 'image/png',
                size: 10,
                semanticIntent: 'visual-reference',
                meta: {},
            }))
        );
        readAttachmentImageForTransportMock.mockRejectedValueOnce(new Error('File unavailable'));
        const parts = await buildAttachmentParts(attachments, { includeAnchorText: false });
        expect(parts).toEqual([
            expect.objectContaining({ sourcePath: 'D:/ok.png', data: 'base64' }),
        ]);
        expect(readAttachmentImageForTransportMock).toHaveBeenCalledTimes(2);
    });
});
