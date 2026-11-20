import { mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, ref } from 'vue';

import { clipboardDraftApiKey } from '@/app/api/attachments/drafts';
import { initializeSearchWindow } from '@/app/bootstrap/search';
import type { Index } from '@/modules/attachments';
import type { ClipboardPayload } from '@/platform/native/types';

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: statMock }));
vi.mock('tauri-plugin-fs-pro-api', () => ({
    fullName: async (path: string) => path.split('/').pop(),
    icon: async () => '/fixture/icon',
    size: async () => 3,
}));

import {
    useSearchAttachments as createSearchAttachments,
    useSearchDraftController as createSearchDraftController,
} from '@/views/SearchView/composables/useSearchInput';

let host: ReturnType<typeof initializeSearchWindow>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
    host = initializeSearchWindow('main');
    app = createApp({ render: () => null });
    app.provide(clipboardDraftApiKey, host.clipboard!);
    statMock.mockResolvedValue({ isFile: true, isDirectory: false });
});
afterEach(() => host.dispose());
const useSearchAttachments = (...args: Parameters<typeof createSearchAttachments>) =>
    app.runWithContext(() => createSearchAttachments(...args));
const useSearchDraftController = (...args: Parameters<typeof createSearchDraftController>) =>
    app.runWithContext(() => createSearchDraftController(...args));

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
        const queryText = ref('Existing');
        const attachments = ref<Index[]>([]);
        const modelOverride = ref({
            modelId: null,
            providerId: null,
        });
        const { createAttachmentFromClipboardPath } = useSearchAttachments({ attachments });
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
        mockTauriCommand('read_clipboard_payload', payload);

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
        expect(attachments.value).toMatchObject([
            {
                type: 'image',
                path: 'D:/clip/image.png',
                name: 'image.png',
                draftInsertionOffset: 14,
            },
            {
                type: 'file',
                path: 'D:/clip/readme.pdf',
                name: 'readme.pdf',
                draftInsertionOffset: 20,
            },
        ]);
    });
});

describe('when the user pastes an existing file path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        statMock.mockResolvedValue({ isFile: false, isDirectory: false });
    });

    it('user gets a file tag instead of the raw path text', async () => {
        const queryText = ref('');
        const attachments = ref<Index[]>([]);
        const modelOverride = ref({ modelId: null, providerId: null });
        const { createAttachmentFromClipboardPath } = useSearchAttachments({ attachments });
        statMock.mockResolvedValue({ isFile: true, isDirectory: false });
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

        expect(attachments.value.map((item) => item.path)).toEqual(['D:/docs/report.pdf']);
        expect(queryText.value).toBe('');
    });
});
