import { beforeEach, describe, expect, it } from 'vitest';

import type { AttachmentIndex } from '@/contracts/attachments';
import { setLocale } from '@/i18n';
import {
    getAttachmentSupportMessage,
    isAttachmentSupported,
    resolveAttachmentSupportStatus,
} from '@/services/AttachmentService';

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

describe('AgentService attachment support i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes app-owned unsupported attachment messages', () => {
        setLocale('en-US');

        expect(getAttachmentSupportMessage(attachment('unsupported-image'))).toBe(
            'This model does not support images.'
        );
        expect(getAttachmentSupportMessage(attachment('unsupported-file'))).toBe(
            'This model does not support files.'
        );
        expect(getAttachmentSupportMessage(attachment('supported'))).toBeNull();
    });

    it('keeps support status logic independent from display language', () => {
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
