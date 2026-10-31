// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { LanguageModelUsage, TextStreamPart, ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';

import { createAiSdkStreamProcessor } from '@/services/AgentService/infrastructure/providers/ai-sdk/stream';

function usage(raw: Record<string, number | null>): LanguageModelUsage {
    return {
        inputTokens: raw.prompt_tokens ?? 0,
        outputTokens: raw.completion_tokens ?? 0,
        totalTokens: 0,
        inputTokenDetails: {
            noCacheTokens: raw.prompt_tokens ?? 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: raw.completion_tokens ?? 0, reasoningTokens: 0 },
        raw,
    };
}

describe('given one provider turn finishes multiple SDK steps', () => {
    const scenarios: Array<[string, Array<Record<string, number | null>>]> = [
        ['before', [{ prompt_tokens: 0 }, {}]],
        ['after', [{}, { completion_tokens: 7 }]],
        ['between', [{}, { prompt_tokens: 0 }, { total_tokens: 12 }]],
    ];
    it.each(scenarios)(
        'user keeps observed usage when a valid report arrives %s an empty step',
        (_label, reports) => {
            const processor = createAiSdkStreamProcessor();
            for (const raw of reports) {
                processor.consumePart({
                    type: 'finish-step',
                    usage: usage(raw),
                } as TextStreamPart<ToolSet>);
            }

            // The SDK's turn aggregate has no raw source fields.
            const finish = processor.buildFinishChunk('stop', { ...usage({}), raw: undefined });

            expect(finish.usageReported).toBe(true);
        }
    );

    it('user gets no observed usage when every step has only defaults or a total count', () => {
        const processor = createAiSdkStreamProcessor();
        const reports: Array<Record<string, number | null>> = [
            {},
            { prompt_tokens: null },
            { total_tokens: 12 },
        ];
        for (const raw of reports) {
            processor.consumePart({
                type: 'finish-step',
                usage: usage(raw),
            } as TextStreamPart<ToolSet>);
        }

        expect(processor.buildFinishChunk('stop', usage({ prompt_tokens: 0 })).usageReported).toBe(
            false
        );
    });
});
