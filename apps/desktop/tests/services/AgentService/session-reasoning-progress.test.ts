import { describe, expect, it } from 'vitest';

import type { PersistedOutputPart } from '@/services/AgentService/session/reasoningProgress';
import {
    parseInterruptedOutputProgress,
    parseInterruptedReasoningProgress,
    serializeOutputParts,
    serializeOutputProgress,
} from '@/services/AgentService/session/reasoningProgress';

describe('interrupted reasoning progress', () => {
    it('round-trips the partial answer and preserves completed wall-clock intervals', () => {
        const serialized = serializeOutputProgress(
            'IntroAnswer',
            [
                { content: 'Plan', startedAt: 1_000, endedAt: 2_000, textOffset: 0 },
                { content: 'Review', startedAt: 3_000, textOffset: 5 },
            ],
            6_500
        );

        expect(parseInterruptedOutputProgress(serialized)).toEqual({
            response: 'IntroAnswer',
            segments: [
                { content: 'Plan', startedAt: 1_000, endedAt: 2_000, textOffset: 0 },
                { content: 'Review', startedAt: 3_000, endedAt: 6_500, textOffset: 5 },
            ],
            savedAt: 6_500,
        });
    });

    it('restores content and closes an active segment at its last persisted wall-clock time', () => {
        expect(
            parseInterruptedReasoningProgress(
                JSON.stringify({
                    segments: [
                        { content: 'Finished thought', startedAt: 1_000, endedAt: 4_200 },
                        { content: 'Saved active thought', startedAt: 5_000 },
                    ],
                    savedAt: 8_000,
                })
            )
        ).toEqual([
            { content: 'Finished thought', startedAt: 1_000, endedAt: 4_200 },
            { content: 'Saved active thought', startedAt: 5_000, endedAt: 8_000 },
        ]);
    });

    it('ignores malformed progress and invalid timestamp segments', () => {
        expect(parseInterruptedReasoningProgress('not json')).toEqual([]);
        expect(
            parseInterruptedReasoningProgress(
                JSON.stringify({
                    segments: [
                        { content: 'No start time', endedAt: 3_000 },
                        { content: 'Invalid end', startedAt: 1_000, endedAt: Infinity },
                    ],
                    savedAt: 4_000,
                })
            )
        ).toEqual([]);
    });
    it('persists ordered reasoning and text parts without text offsets', () => {
        const parts: PersistedOutputPart[] = [
            { type: 'reasoning', content: 'Plan', startedAt: 1_000, endedAt: 2_000 },
            { type: 'text', content: 'First answer' },
            { type: 'reasoning', content: 'Review', startedAt: 3_000 },
            { type: 'text', content: 'Final answer' },
        ];
        const serialized = serializeOutputProgress(parts, 6_500);

        expect(JSON.parse(serialized)).toEqual({
            version: 2,
            parts,
            savedAt: 6_500,
        });
        expect(parseInterruptedOutputProgress(serialized)).toEqual({
            version: 2,
            parts: [
                { type: 'reasoning', content: 'Plan', startedAt: 1_000, endedAt: 2_000 },
                { type: 'text', content: 'First answer' },
                { type: 'reasoning', content: 'Review', startedAt: 3_000, endedAt: 6_500 },
                { type: 'text', content: 'Final answer' },
            ],
            savedAt: 6_500,
        });
    });

    it('serializes message output parts as the canonical ordered metadata', () => {
        const parts: PersistedOutputPart[] = [
            { type: 'reasoning', content: 'Plan', startedAt: 1_000, endedAt: 2_000 },
            { type: 'text', content: 'Answer' },
        ];

        expect(JSON.parse(serializeOutputParts(parts))).toEqual({ version: 2, parts });
    });
});
