import { describe, expect, it } from 'vitest';

import type { PersistedOutputPart } from '@/services/AgentService/session/reasoningProgress';
import {
    getReasoningSegmentsFromOutputParts,
    normalizeOutputParts,
} from '@/services/AgentService/session/reasoningProgress';

describe('persisted output parts', () => {
    it('keeps a durable reasoning-start marker without accepting empty text', () => {
        expect(
            normalizeOutputParts([
                { type: 'reasoning', content: '', startedAt: 1000 },
                { type: 'reasoning', content: '' },
                { type: 'text', content: '' },
            ])
        ).toEqual([{ type: 'reasoning', content: '', startedAt: 1000 }]);
    });

    it('serializes and restores ordered message parts with wall-clock boundaries', () => {
        const parts: PersistedOutputPart[] = [
            { type: 'reasoning', content: 'Plan', startedAt: 1_000, endedAt: 2_000 },
            { type: 'text', content: 'First answer' },
            { type: 'reasoning', content: 'Review', startedAt: 3_000, endedAt: 6_500 },
            { type: 'text', content: 'Final answer' },
        ];
        expect(normalizeOutputParts(parts)).toEqual(parts);
        expect(getReasoningSegmentsFromOutputParts(parts)).toEqual([
            { content: 'Plan', startedAt: 1_000, endedAt: 2_000 },
            { content: 'Review', startedAt: 3_000, endedAt: 6_500 },
        ]);
    });
});
