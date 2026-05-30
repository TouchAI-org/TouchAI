import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { setLocale } from '@/i18n';
import type { Index } from '@/services/AgentService/infrastructure/attachments';
import { useSearchAttachments } from '@/views/SearchView/composables/useSearchInput';

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

describe('useSearchInput i18n boundaries', () => {
    it('returns localized source text for unsupported image attachment errors', () => {
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

    it('returns localized source text for unsupported mixed attachment errors', () => {
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
