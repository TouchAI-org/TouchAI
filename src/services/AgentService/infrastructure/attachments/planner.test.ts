import { describe, expect, it } from 'vitest';

import { buildAttachmentTransportDecision } from './planner';

describe('buildAttachmentTransportDecision', () => {
    it('keeps large OpenAI images inline because chat file_id cannot represent image refs', () => {
        const decision = buildAttachmentTransportDecision({
            kind: 'image',
            size: 2 * 1024 * 1024,
            providerDriver: 'openai',
        });

        expect(decision.transportMode).toBe('inline-image');
        expect(decision.shouldUpload).toBe(false);
        expect(decision.canReuseRemoteRef).toBe(false);
    });

    it('still prefers provider file refs for OpenAI PDFs', () => {
        const decision = buildAttachmentTransportDecision({
            kind: 'pdf',
            size: 2 * 1024 * 1024,
            providerDriver: 'openai',
        });

        expect(decision.transportMode).toBe('provider-file-ref');
        expect(decision.shouldUpload).toBe(true);
        expect(decision.canReuseRemoteRef).toBe(true);
    });
});
