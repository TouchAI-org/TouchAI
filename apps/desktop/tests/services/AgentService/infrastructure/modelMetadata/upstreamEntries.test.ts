import { describe, expect, it } from 'vitest';

import {
    toUpstreamModelMetadataEntries,
    toUpstreamModelMetadataPatch,
} from '@/services/AgentService/infrastructure/modelMetadata/upstreamEntries';

describe('user sees upstream capability declarations turned into model metadata', () => {
    it('user sees domain capabilities mapped onto the model columns', () => {
        expect(
            toUpstreamModelMetadataPatch({
                contextLimit: 400_000,
                outputLimit: 128_000,
                modalities: { input: ['text', 'image'], output: ['text'] },
                attachment: true,
                reasoning: true,
                reasoningOptions: [{ type: 'effort', values: ['low', 'max'] }],
                toolCall: true,
            })
        ).toEqual({
            context_limit: 400_000,
            output_limit: 128_000,
            modalities: '{"input":["text","image"],"output":["text"]}',
            attachment: 1,
            reasoning: 1,
            reasoning_options: '[{"type":"effort","values":["low","max"]}]',
            tool_call: 1,
        });
    });

    it('user sees explicit false declarations mapped to zero bits', () => {
        expect(
            toUpstreamModelMetadataPatch({ reasoning: false, toolCall: false, attachment: false })
        ).toEqual({ reasoning: 0, tool_call: 0, attachment: 0 });
    });

    it('user sees patches without any declared field dropped', () => {
        expect(toUpstreamModelMetadataPatch({})).toBeUndefined();
        expect(toUpstreamModelMetadataPatch({ reasoningOptions: [] })).toBeUndefined();
    });
});

describe('user sees upstream entries listed for models', () => {
    it('user sees only models that declare capabilities kept', () => {
        expect(
            toUpstreamModelMetadataEntries([
                {
                    id: 'group/auto-gpt-5-6-sol',
                    name: 'sol',
                    capabilities: { contextLimit: 400_000 },
                },
                { id: 'qianai/plain-model', name: 'plain' },
                { id: 'qianai/empty-model', name: 'empty', capabilities: {} },
            ])
        ).toEqual([{ model_id: 'group/auto-gpt-5-6-sol', metadata: { context_limit: 400_000 } }]);
    });
});
