import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readAttachmentAsBase64Mock, readAttachmentAsTextMock, inspectAttachmentsMock } = vi.hoisted(
    () => ({
        readAttachmentAsBase64Mock: vi.fn(),
        readAttachmentAsTextMock: vi.fn(),
        inspectAttachmentsMock: vi.fn(),
    })
);

vi.mock('@/services/AgentService/infrastructure/attachments/content', () => ({
    readAttachmentAsBase64: readAttachmentAsBase64Mock,
    readAttachmentAsText: readAttachmentAsTextMock,
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
        inspectAttachmentsMock.mockReset();

        readAttachmentAsBase64Mock.mockResolvedValue({ data: 'base64' });
        readAttachmentAsTextMock.mockResolvedValue({ content: 'text', isBinary: false });
    });

    it('reads each attachment source only once per materialization', async () => {
        const attachments = [createAttachment('a'), createAttachment('a')];
        inspectAttachmentsMock.mockResolvedValue(
            attachments.map((attachment, index) => ({
                attachment,
                kind: 'image',
                mimeType: 'image/png',
                size: 10,
                semanticIntent: 'inline',
                meta: { index },
            }))
        );

        await buildAttachmentParts(attachments);

        // 同一个源路径只解码一次，避免重复大文件读取。
        expect(readAttachmentAsBase64Mock).toHaveBeenCalledTimes(1);
        expect(readAttachmentAsBase64Mock).toHaveBeenCalledWith(
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
                semanticIntent: 'inline',
                meta: { index },
            }))
        );

        await buildAttachmentParts(attachments);

        expect(readAttachmentAsBase64Mock).toHaveBeenCalledTimes(2);
    });
});
