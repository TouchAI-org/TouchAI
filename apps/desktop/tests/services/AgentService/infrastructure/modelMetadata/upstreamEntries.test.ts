import { describe, expect, it } from 'vitest';

import {
    toUpstreamModelMetadataEntries,
    toUpstreamModelMetadataPatch,
} from '@/services/AgentService/infrastructure/modelMetadata/upstreamEntries';

describe('toUpstreamModelMetadataPatch', () => {
    it('maps domain capabilities onto the model columns', () => {
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

    it('maps explicit false declarations to zero bits', () => {
        expect(
            toUpstreamModelMetadataPatch({ reasoning: false, toolCall: false, attachment: false })
        ).toEqual({ reasoning: 0, tool_call: 0, attachment: 0 });
    });

    it('drops patches without any declared field', () => {
        expect(toUpstreamModelMetadataPatch({})).toBeUndefined();
        expect(toUpstreamModelMetadataPatch({ reasoningOptions: [] })).toBeUndefined();
    });
});

describe('toUpstreamModelMetadataEntries', () => {
    it('keeps models that declare capabilities and skips the rest', () => {
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
