// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { describe, expect, it } from 'vitest';

import { buildMetadataList } from '@services/AgentService/infrastructure/modelMetadata/catalog';

/** models.dev 的真实结构（精简到与定价相关的字段） */
const catalogFixture = {
    deepseek: {
        models: {
            'deepseek-v4-flash': {
                id: 'deepseek-v4-flash',
                name: 'DeepSeek V4 Flash',
                attachment: false,
                reasoning: true,
                tool_call: true,
                temperature: true,
                open_weights: true,
                modalities: { input: ['text'], output: ['text'] },
                limit: { context: 1048576, output: 943718 },
                cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
            },
        },
    },
    anthropic: {
        models: {
            'claude-sonnet-4-5': {
                id: 'claude-sonnet-4-5',
                name: 'Claude Sonnet 4.5',
                attachment: true,
                reasoning: true,
                tool_call: true,
                temperature: true,
                open_weights: false,
                modalities: { input: ['text', 'image'], output: ['text'] },
                limit: { context: 200000, output: 64000 },
                cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            },
            'no-price-model': {
                id: 'no-price-model',
                name: 'Model Without Price',
                attachment: false,
                reasoning: false,
                tool_call: false,
                temperature: true,
                open_weights: true,
                modalities: { input: ['text'], output: ['text'] },
                limit: { context: 8192, output: 4096 },
            },
        },
    },
};

describe('buildMetadataList pricing', () => {
    it('keeps the per-million cost fields from the catalog', () => {
        const { metadataList } = buildMetadataList(catalogFixture);
        const deepseek = metadataList.find((row) => row.model_id === 'deepseek-v4-flash');

        expect(deepseek).toBeDefined();
        expect(deepseek!.input_cost_per_million).toBe('0.15');
        expect(deepseek!.output_cost_per_million).toBe('0.6');
        expect(deepseek!.cache_read_cost_per_million).toBe('0.003');
        // 数据源没给 cache_write，留空而不是编造 0
        expect(deepseek!.cache_write_cost_per_million).toBeNull();
        expect(deepseek!.cost_currency).toBe('USD');
    });

    it('keeps all four prices when the vendor reports them', () => {
        const { metadataList } = buildMetadataList(catalogFixture);
        const claude = metadataList.find((row) => row.model_id === 'claude-sonnet-4-5');

        expect(claude!.input_cost_per_million).toBe('3');
        expect(claude!.output_cost_per_million).toBe('15');
        expect(claude!.cache_read_cost_per_million).toBe('0.3');
        expect(claude!.cache_write_cost_per_million).toBe('3.75');
    });

    it('leaves pricing empty for a model the catalog does not price', () => {
        const { metadataList } = buildMetadataList(catalogFixture);
        const free = metadataList.find((row) => row.model_id === 'no-price-model');

        expect(free).toBeDefined();
        expect(free!.input_cost_per_million).toBeNull();
        expect(free!.output_cost_per_million).toBeNull();
        expect(free!.cost_currency).toBeNull();
    });

    it('does not invent a price of zero for an unpriced model', () => {
        const { metadataList } = buildMetadataList(catalogFixture);
        const free = metadataList.find((row) => row.model_id === 'no-price-model');

        // 关键：未知价 ≠ 免费。写 '0' 会让成本合计失真。
        expect(free!.input_cost_per_million).not.toBe('0');
        expect(free!.output_cost_per_million).not.toBe('0');
    });
});
