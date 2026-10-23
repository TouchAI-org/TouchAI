import { describe, expect, it } from 'vitest';

import {
    normalizeOutputParts,
    type PersistedOutputPart,
} from '@/services/AgentService/contracts/protocol';

describe('a saved answer keeps its parts and timings', () => {
    it('user sees a durable reasoning-start marker without empty text', () => {
        expect(
            normalizeOutputParts([
                { type: 'reasoning', content: '', startedAt: 1000 },
                { type: 'reasoning', content: '' },
                { type: 'text', content: '' },
            ])
        ).toEqual([{ type: 'reasoning', content: '', startedAt: 1000 }]);
    });

    it('user sees ordered parts restored with their wall-clock boundaries', () => {
        const parts: PersistedOutputPart[] = [
            { type: 'reasoning', content: 'Plan', startedAt: 1_000, endedAt: 2_000 },
            { type: 'text', content: 'First answer' },
            { type: 'reasoning', content: 'Review', startedAt: 3_000, endedAt: 6_500 },
            { type: 'text', content: 'Final answer' },
        ];
        expect(normalizeOutputParts(parts)).toEqual(parts);
    });

    it('user sees valid reasoning provider options preserved', () => {
        const parts: PersistedOutputPart[] = [
            {
                type: 'reasoning',
                content: 'Plan',
                providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' } },
            },
        ];
        expect(normalizeOutputParts(parts)).toEqual(parts);
    });

    it('user sees malformed reasoning provider options dropped', () => {
        expect(
            normalizeOutputParts([
                { type: 'reasoning', content: 'Plan', providerOptions: 'nope' },
                { type: 'reasoning', content: 'Plan', providerOptions: { openai: 'nope' } },
                { type: 'reasoning', content: 'Plan', providerOptions: {} },
            ])
        ).toEqual([
            { type: 'reasoning', content: 'Plan' },
            { type: 'reasoning', content: 'Plan' },
            { type: 'reasoning', content: 'Plan' },
        ]);
    });
});
