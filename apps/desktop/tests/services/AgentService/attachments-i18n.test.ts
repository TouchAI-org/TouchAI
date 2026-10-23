import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import {
    getAttachmentSupportMessage,
    isAttachmentSupported,
    resolveAttachmentSupportStatus,
} from '@/services/AgentService/infrastructure/attachments';

function attachment(supportStatus: AttachmentIndex['supportStatus']): AttachmentIndex {
    return {
        id: 'attachment-1',
        name: 'diagram.png',
        type: 'image',
        path: 'D:/diagram.png',
        originPath: 'D:/diagram.png',
        mimeType: 'image/png',
        supportStatus,
    };
}

describe('user reads attachment capability messages in their language', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user reads the unsupported-attachment message in the active language', () => {
        setLocale('en-US');

        expect(getAttachmentSupportMessage(attachment('unsupported-image'))).toBe(
            'This model does not support images.'
        );
        expect(getAttachmentSupportMessage(attachment('unsupported-file'))).toBe(
            'This model does not support files.'
        );
        expect(getAttachmentSupportMessage(attachment('supported'))).toBeNull();
    });

    it('user sees the same support verdict whatever the display language is', () => {
        setLocale('en-US');

        expect(
            resolveAttachmentSupportStatus('image', {
                supportsImages: false,
                supportsFiles: true,
            })
        ).toBe('unsupported-image');
        expect(
            resolveAttachmentSupportStatus('file', {
                supportsImages: true,
                supportsFiles: false,
            })
        ).toBe('unsupported-file');
        expect(
            resolveAttachmentSupportStatus('image', {
                supportsImages: true,
                supportsFiles: false,
            })
        ).toBe('supported');
        expect(
            resolveAttachmentSupportStatus('file', {
                supportsImages: false,
                supportsFiles: true,
            })
        ).toBe('supported');
        expect(isAttachmentSupported(attachment('supported'))).toBe(true);
        expect(isAttachmentSupported(attachment('unsupported-file'))).toBe(false);
    });
});
