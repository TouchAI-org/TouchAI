import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import type { Index } from '@/services/AgentService/infrastructure/attachments';
import type { ClipboardPayload } from '@/services/NativeService/types';

const { createAttachmentMock, readExplicitPastePayloadMock } = vi.hoisted(() => ({
    createAttachmentMock: vi.fn(),
    readExplicitPastePayloadMock: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/attachments', async () => {
    const actual = await vi.importActual<
        typeof import('@/services/AgentService/infrastructure/attachments')
    >('@/services/AgentService/infrastructure/attachments');
    return {
        ...actual,
        createAttachment: createAttachmentMock,
    };
});

vi.mock('@/services/ClipboardService', () => ({
    clipboardService: {
        readExplicitPastePayload: readExplicitPastePayloadMock,
    },
}));

import { useSearchAttachments, useSearchDraftController } from './useSearchInput';

function createAttachmentIndex(
    id: string,
    type: Index['type'],
    overrides: Partial<Index> = {}
): Index {
    const extension = type === 'image' ? 'png' : 'txt';
    const path = overrides.path ?? `D:/${id}.${extension}`;
    return {
        id,
        type,
        path,
        originPath: overrides.originPath ?? path,
        name: overrides.name ?? `${id}.${extension}`,
        supportStatus: overrides.supportStatus,
        preview: overrides.preview,
        draftInsertionOffset: overrides.draftInsertionOffset,
        attachmentId: overrides.attachmentId,
        hash: overrides.hash,
        size: overrides.size,
        mimeType: overrides.mimeType,
    };
}

describe('useSearchAttachments', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createAttachmentMock.mockImplementation(async (type: Index['type'], path: string) =>
            createAttachmentIndex(`created-${type}`, type, { path })
        );
    });

    it('syncs attachment support states from the active model capabilities', () => {
        const image = createAttachmentIndex('image', 'image');
        const file = createAttachmentIndex('file', 'file');
        const attachmentsRef = ref<Index[]>([image, file]);
        const attachments = useSearchAttachments({
            attachments: attachmentsRef,
        });

        attachments.handleModelChange({
            supportsImages: true,
            supportsFiles: false,
        });

        expect(attachmentsRef.value.map((attachment) => attachment.supportStatus)).toEqual([
            'supported',
            'unsupported-file',
        ]);
        expect(attachments.getSupportedAttachments()).toEqual([attachmentsRef.value[0]]);
        expect(attachments.getUnsupportedAttachmentMessage()).toBeTruthy();

        attachments.handleModelChange({
            supportsImages: true,
            supportsFiles: true,
        });

        expect(attachments.getUnsupportedAttachmentMessage()).toBeNull();
    });

    it('normalizes clipboard attachments and exposes removal helpers', async () => {
        const attachmentsRef = ref<Index[]>([
            createAttachmentIndex('keep', 'image'),
            createAttachmentIndex('remove', 'file'),
        ]);
        const attachments = useSearchAttachments({
            attachments: attachmentsRef,
        });

        attachments.handleModelChange({
            supportsImages: false,
            supportsFiles: true,
        });

        const created = await attachments.createAttachmentFromClipboardPath('image', 'D:/clip.png');

        expect(created.supportStatus).toBe('unsupported-image');
        expect(attachments.removeAttachment('remove')).toBe(true);
        expect(attachments.removeAttachment('missing')).toBe(false);

        attachments.clearAttachments();
        expect(attachmentsRef.value).toEqual([]);
    });
});

describe('useSearchDraftController', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('clears the current draft and optionally preserves the model override', () => {
        const queryText = ref('touchai');
        const attachments = ref<Index[]>([createAttachmentIndex('draft-file', 'file')]);
        const modelOverride = ref({
            modelId: 'model-1',
            providerId: 7,
        });
        const controller = useSearchDraftController({
            queryText,
            attachments,
            modelOverride,
            clearAttachments: () => {
                attachments.value = [];
            },
            createAttachmentFromClipboardPath: vi.fn(),
        });

        controller.clearDraft({ preserveModelTag: true });

        expect(queryText.value).toBe('');
        expect(attachments.value).toEqual([]);
        expect(modelOverride.value).toEqual({
            modelId: 'model-1',
            providerId: 7,
        });

        queryText.value = 'new prompt';
        attachments.value = [createAttachmentIndex('next-file', 'file')];
        controller.clearDraft();

        expect(modelOverride.value).toEqual({
            modelId: null,
            providerId: null,
        });
    });

    it('imports ordered clipboard fragments into the draft with trimmed text boundaries', async () => {
        let attachmentSequence = 0;
        const queryText = ref('Existing');
        const attachments = ref<Index[]>([]);
        const modelOverride = ref({
            modelId: null,
            providerId: null,
        });
        const createAttachmentFromClipboardPath = vi.fn(
            async (type: Index['type'], path: string): Promise<Index> => {
                attachmentSequence += 1;
                return createAttachmentIndex(`${type}-${attachmentSequence}`, type, {
                    path,
                    name: path.split('/').pop() ?? path,
                });
            }
        );
        const payload: ClipboardPayload = {
            snapshotId: 'snapshot-1',
            observedAt: Date.now(),
            text: '  Hello world  ',
            imagePaths: [],
            filePaths: [],
            fragments: [
                { type: 'text', text: '  Hello' },
                { type: 'image', path: 'D:/clip/image.png' },
                { type: 'text', text: ' world  ' },
                { type: 'file', path: 'D:/clip/readme.pdf' },
            ],
        };
        readExplicitPastePayloadMock.mockResolvedValue(payload);

        const controller = useSearchDraftController({
            queryText,
            attachments,
            modelOverride,
            clearAttachments: () => {
                attachments.value = [];
            },
            createAttachmentFromClipboardPath,
        });

        await controller.handlePaste();

        expect(queryText.value).toBe('Existing\nHello world');
        expect(createAttachmentFromClipboardPath).toHaveBeenNthCalledWith(
            1,
            'image',
            'D:/clip/image.png'
        );
        expect(createAttachmentFromClipboardPath).toHaveBeenNthCalledWith(
            2,
            'file',
            'D:/clip/readme.pdf'
        );
        expect(attachments.value).toEqual([
            createAttachmentIndex('image-1', 'image', {
                path: 'D:/clip/image.png',
                name: 'image.png',
                draftInsertionOffset: 14,
            }),
            createAttachmentIndex('file-2', 'file', {
                path: 'D:/clip/readme.pdf',
                name: 'readme.pdf',
                draftInsertionOffset: 20,
            }),
        ]);
    });
});
