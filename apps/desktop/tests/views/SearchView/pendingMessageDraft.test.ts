import { describe, expect, it } from 'vitest';

import { resolvePendingMessageModelOverride } from '@/views/SearchView/pendingMessageDraft';

describe('user edits a queued message', () => {
    it('user gets the model saved on the queued message', () => {
        expect(
            resolvePendingMessageModelOverride({
                modelId: 'model-1',
                providerId: 2,
            })
        ).toEqual({ modelId: 'model-1', providerId: 2 });
    });

    it('user gets the default model when the queued message has no override', () => {
        expect(resolvePendingMessageModelOverride({})).toEqual({
            modelId: null,
            providerId: null,
        });
    });
});
