import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import type { ClipboardPayload } from '@/services/NativeService/types';
import {
    applyClipboardPayloadToDraft,
    canAutoPasteIntoDraft,
    clipboardPayloadHasAttachmentFragments,
} from '@/views/SearchView/utils/clipboardDraft';

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

describe('when the user pastes into the search bar', () => {
    it('user gets the clipboard pasted automatically only into an untouched draft', () => {
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

    it('user gets plain clipboard text trimmed with its files appended', async () => {
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

    it('user gets files from an attachment-only paste added after the current text', async () => {
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

    it('user gets pasted files detected separately from pasted text', () => {
        expect(
            clipboardPayloadHasAttachmentFragments({
                snapshotId: 'text-fragments',
                observedAt: Date.now(),
                text: 'hello',
                imagePaths: [],
                filePaths: [],
                fragments: [{ type: 'text', text: 'hello' }],
            })
        ).toBe(false);

        expect(
            clipboardPayloadHasAttachmentFragments({
                snapshotId: 'mixed-fragments',
                observedAt: Date.now(),
                text: 'hello world',
                imagePaths: ['D:/clip/image.png'],
                filePaths: [],
                fragments: [
                    { type: 'text', text: 'hello ' },
                    { type: 'image', path: 'D:/clip/image.png' },
                    { type: 'text', text: ' world' },
                ],
            })
        ).toBe(true);
    });
});
