import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, ref } from 'vue';

import { clipboardDraftApiKey } from '@/app/api/attachments/drafts';
import { initializeSearchWindow } from '@/app/bootstrap/search';
import { setLocale } from '@/i18n';
import type { Index } from '@/modules/attachments';
import { useSearchAttachments as createSearchAttachments } from '@/views/SearchView/composables/useSearchInput';

let host: ReturnType<typeof initializeSearchWindow>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
    host = initializeSearchWindow('main');
    app = createApp({ render: () => null });
    app.provide(clipboardDraftApiKey, host.clipboard!);
});
afterEach(() => {
    host.dispose();
    setLocale('zh-CN');
});
const useSearchAttachments = (...args: Parameters<typeof createSearchAttachments>) =>
    app.runWithContext(() => createSearchAttachments(...args));

function createAttachmentIndex(
    id: string,
    type: Index['type'],
    supportStatus: Index['supportStatus']
): Index {
    const extension = type === 'image' ? 'png' : 'txt';
    return {
        id,
        type,
        path: `D:/${id}.${extension}`,
        originPath: `D:/${id}.${extension}`,
        name: `${id}.${extension}`,
        supportStatus,
    };
}

describe('user attaches a file to a prompt', () => {
    it('user gets localized source text for unsupported image attachment errors', () => {
        setLocale('en-US');
        const attachments = useSearchAttachments({
            attachments: ref<Index[]>([
                createAttachmentIndex('unsupported-image', 'image', 'unsupported-image'),
            ]),
        });

        expect(attachments.getUnsupportedAttachmentMessage()).toBe(
            'The current model does not support images. Remove unsupported attachments or switch models.'
        );

        setLocale('zh-CN');
    });

    it('user gets localized source text for unsupported mixed attachment errors', () => {
        setLocale('en-US');
        const attachments = useSearchAttachments({
            attachments: ref<Index[]>([
                createAttachmentIndex('unsupported-image', 'image', 'unsupported-image'),
                createAttachmentIndex('unsupported-file', 'file', 'unsupported-file'),
            ]),
        });

        expect(attachments.getUnsupportedAttachmentMessage()).toBe(
            'The current model does not support images or files. Remove unsupported attachments or switch models.'
        );

        setLocale('zh-CN');
    });
});
