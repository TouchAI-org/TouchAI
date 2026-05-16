import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import type { ClipboardPayload } from '@/services/NativeService/types';

import { applyClipboardPayloadToDraft, canAutoPasteIntoDraft } from './clipboardDraft';

interface DraftAttachment {
    type: 'image' | 'file';
    path: string;
    draftInsertionOffset?: number;
}

function createTarget(initialText = '') {
    return {
        queryText: ref(initialText),
        attachments: ref<DraftAttachment[]>([]),
        appendText: (current: string, next: string) =>
            [current, next].filter(Boolean).join(current ? '\n' : ''),
        createAttachment: async (
            type: 'image' | 'file',
            path: string
        ): Promise<DraftAttachment> => ({
            type,
            path,
        }),
    };
}

describe('clipboardDraft', () => {
    it('allows auto-paste only when the draft, session, and model state are all empty', () => {
        expect(
            canAutoPasteIntoDraft({
                queryText: '   ',
                attachmentCount: 0,
                sessionMessageCount: 0,
                hasModelOverride: false,
            })
        ).toBe(true);

        expect(
            canAutoPasteIntoDraft({
                queryText: 'hello',
                attachmentCount: 0,
                sessionMessageCount: 0,
                hasModelOverride: false,
            })
        ).toBe(false);
        expect(
            canAutoPasteIntoDraft({
                queryText: '',
                attachmentCount: 1,
                sessionMessageCount: 0,
                hasModelOverride: false,
            })
        ).toBe(false);
        expect(
            canAutoPasteIntoDraft({
                queryText: '',
                attachmentCount: 0,
                sessionMessageCount: 1,
                hasModelOverride: false,
            })
        ).toBe(false);
        expect(
            canAutoPasteIntoDraft({
                queryText: '',
                attachmentCount: 0,
                sessionMessageCount: 0,
                hasModelOverride: true,
            })
        ).toBe(false);
    });

    it('trims plain clipboard text boundaries and appends created attachments when no fragments are present', async () => {
        const target = createTarget('Existing');
        const payload: ClipboardPayload = {
            snapshotId: 'plain-1',
            observedAt: Date.now(),
            text: '  hello world  ',
            imagePaths: ['D:/clip/image.png'],
            filePaths: ['D:/clip/file.txt'],
        };

        await applyClipboardPayloadToDraft(payload, target, {
            trimTextBoundary: true,
        });

        expect(target.queryText.value).toBe('Existing\nhello world');
        expect(target.attachments.value).toEqual([
            {
                type: 'image',
                path: 'D:/clip/image.png',
            },
            {
                type: 'file',
                path: 'D:/clip/file.txt',
            },
        ]);
    });

    it('projects attachment-only fragments back to the end of the current draft when no text fragments exist', async () => {
        const target = createTarget('Draft');
        const payload: ClipboardPayload = {
            snapshotId: 'fragments-1',
            observedAt: Date.now(),
            text: null,
            imagePaths: [],
            filePaths: [],
            fragments: [
                { type: 'image', path: 'D:/clip/one.png' },
                { type: 'file', path: 'D:/clip/two.txt' },
            ],
        };

        await applyClipboardPayloadToDraft(payload, target, {
            trimTextBoundary: true,
        });

        expect(target.queryText.value).toBe('Draft');
        expect(target.attachments.value).toEqual([
            {
                type: 'image',
                path: 'D:/clip/one.png',
                draftInsertionOffset: 5,
            },
            {
                type: 'file',
                path: 'D:/clip/two.txt',
                draftInsertionOffset: 5,
            },
        ]);
    });
});
