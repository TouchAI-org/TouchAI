import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import type { Index } from '@/services/AgentService/infrastructure/attachments';
import type { ClipboardPayload } from '@/services/NativeService/types';

const { createAttachmentMock, readExplicitPastePayloadMock, resolvePastedPathAttachmentMock } =
    vi.hoisted(() => ({
        createAttachmentMock: vi.fn(),
        readExplicitPastePayloadMock: vi.fn(),
        resolvePastedPathAttachmentMock: vi.fn(),
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

vi.mock('@/services/SearchService/pastedPath', () => ({
    resolvePastedPathAttachment: resolvePastedPathAttachmentMock,
}));
import {
    useSearchAttachments,
    useSearchDraftController,
} from '@/views/SearchView/composables/useSearchInput';

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

describe('when the user adds files to the draft', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createAttachmentMock.mockImplementation(async (type: Index['type'], path: string) =>
            createAttachmentIndex(`created-${type}`, type, { path })
        );
    });

    it('user sees each file marked as unsupported when the model cannot read it', () => {
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

    it('user gets pasted files normalised and can remove them again', async () => {
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

    it('user gets a referenced folder marked as a directory attachment', () => {
        const attachments = useSearchAttachments();
        attachments.handleModelChange({ supportsImages: true, supportsFiles: true });

        const attachment = attachments.createAttachmentFromSearchResult({
            name: 'Documents',
            path: '/Users/me/Documents',
            source: 'folder',
        });

        expect(attachment).toMatchObject({
            type: 'file',
            mimeType: 'application/x-directory',
            path: '/Users/me/Documents',
        });
        expect(attachment.supportStatus).toBe('supported');
    });

    it('user given an existing file when restoring another reference then keeps both in order with current model support', () => {
        const attachments = useSearchAttachments({
            attachments: ref([createAttachmentIndex('keep', 'file')]),
        });
        attachments.handleModelChange({ supportsFiles: true, supportsImages: false });

        attachments.restoreAttachment(
            createAttachmentIndex('restored', 'image', { supportStatus: 'supported' })
        );

        expect(
            attachments.attachments.value.map(({ id, supportStatus }) => ({ id, supportStatus }))
        ).toEqual([
            { id: 'keep', supportStatus: 'supported' },
            { id: 'restored', supportStatus: 'unsupported-image' },
        ]);
    });

    it('user given a reference already in the draft when its restoration repeats then retains one unchanged attachment', () => {
        const attachment = createAttachmentIndex('keep', 'file');
        const attachments = useSearchAttachments({ attachments: ref([attachment]) });
        attachments.handleModelChange({ supportsFiles: true, supportsImages: true });

        attachments.restoreAttachment(createAttachmentIndex('keep', 'file', { name: 'stale.txt' }));

        expect(attachments.attachments.value).toEqual([
            { ...attachment, supportStatus: 'supported' },
        ]);
    });
});

describe('when the draft is replaced or cleared', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user gets the draft cleared while the model chip can stay', () => {
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

    it('user gets pasted text and files placed in their original order', async () => {
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

describe('when the user pastes an existing file path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolvePastedPathAttachmentMock.mockResolvedValue(null);
    });

    it('user gets a file tag instead of the raw path text', async () => {
        const queryText = ref('');
        const attachments = ref<Index[]>([]);
        const modelOverride = ref({ modelId: null, providerId: null });
        const createAttachmentFromClipboardPath = vi.fn(
            async (type: Index['type'], path: string): Promise<Index> =>
                createAttachmentIndex('pasted', type, { path, name: 'report.pdf' })
        );
        resolvePastedPathAttachmentMock.mockResolvedValue({
            type: 'file',
            path: 'D:/docs/report.pdf',
        });
        const payload: ClipboardPayload = {
            snapshotId: 'path-1',
            observedAt: Date.now(),
            text: '"D:/docs/report.pdf"',
            imagePaths: [],
            filePaths: [],
        };
        const controller = useSearchDraftController({
            queryText,
            attachments,
            modelOverride,
            clearAttachments: () => {
                attachments.value = [];
            },
            createAttachmentFromClipboardPath,
        });

        await controller.importClipboardPayload(payload, { trimTextBoundary: true });

        expect(createAttachmentFromClipboardPath).toHaveBeenCalledWith(
            'file',
            'D:/docs/report.pdf'
        );
        expect(attachments.value.map((item) => item.path)).toEqual(['D:/docs/report.pdf']);
        expect(queryText.value).toBe('');
    });
});
