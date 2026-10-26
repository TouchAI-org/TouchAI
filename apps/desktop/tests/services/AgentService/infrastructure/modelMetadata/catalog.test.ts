/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { describe, expect, it } from 'vitest';

import {
    buildCatalog,
    buildMetadataList,
} from '@/services/AgentService/infrastructure/modelMetadata/catalog';

type RawModel = Record<string, unknown>;

/** One provider as models.dev shapes it: a `models` map keyed by the provider's own spelling. */
function provider(models: Record<string, RawModel>): RawModel {
    return { models };
}

function model(id: string, name: string, overrides: RawModel = {}): RawModel {
    return { id, name, ...overrides };
}

function metadataFor(metadataList: { model_id: string }[], modelId: string) {
    return metadataList.find((entry) => entry.model_id === modelId) as
        | Record<string, unknown>
        | undefined;
}

describe('user refreshes model metadata from the upstream catalog', () => {
    it('user sees the owner entry kept when relays list the same canonical model', () => {
        const catalog = buildCatalog({
            openai: provider({
                'gpt-4o': model('gpt-4o', 'Owner GPT-4o', {
                    canonical_model_id: 'openai/gpt-4o',
                }),
            }),
            azure: provider({
                'gpt-4o': model('azure-gpt-4o', 'Relay GPT-4o', {
                    canonical_model_id: 'openai/gpt-4o',
                }),
            }),
        });

        expect(Object.keys(catalog.models)).toEqual(['openai/gpt-4o']);
        expect(catalog.models['openai/gpt-4o']?.name).toBe('Owner GPT-4o');
    });

    it('user sees an owner entry under another key preferred over relay copies', () => {
        const catalog = buildCatalog({
            openai: provider({
                'gpt-4o-2024-08-06': model('gpt-4o-2024-08-06', 'Owner dated GPT-4o', {
                    canonical_model_id: 'openai/gpt-4o',
                }),
            }),
            azure: provider({
                'gpt-4o': model('azure-gpt-4o', 'Relay GPT-4o', {
                    canonical_model_id: 'openai/gpt-4o',
                }),
            }),
            relay: provider({
                cheap: model('cheap', 'Cheap GPT-4o', {
                    canonical_model_id: 'openai/gpt-4o',
                }),
            }),
        });

        expect(catalog.models['openai/gpt-4o']?.name).toBe('Owner dated GPT-4o');
    });

    it('user sees a relay entry spelled like the canonical name preferred over an arbitrary key', () => {
        const catalog = buildCatalog({
            relay: provider({
                thing: model('thing-relay', 'Relay Thing', {
                    canonical_model_id: 'vendor/thing',
                }),
            }),
            reseller: provider({
                zzz: model('zzz', 'Reseller Thing', { canonical_model_id: 'vendor/thing' }),
            }),
        });

        expect(catalog.models['vendor/thing']?.name).toBe('Relay Thing');
    });

    it('user sees the copy carrying more model details kept when relays tie on priority', () => {
        const catalog = buildCatalog({
            relayA: provider({
                k1: model('k1', 'Detailed Thing', {
                    canonical_model_id: 'vendor/x',
                    knowledge: '2025-01',
                    limit: { context: 200000 },
                }),
            }),
            relayB: provider({
                k2: model('k2', 'Bare Thing', { canonical_model_id: 'vendor/x' }),
            }),
        });

        expect(catalog.models['vendor/x']?.name).toBe('Detailed Thing');
    });

    it('user sees the model with documented reasoning options kept over a bare copy', () => {
        const catalog = buildCatalog({
            relayA: provider({
                k1: model('k1', 'Thinking Thing', {
                    canonical_model_id: 'vendor/x',
                    reasoning: true,
                    reasoning_options: [{ type: 'toggle' }],
                }),
            }),
            relayB: provider({
                k2: model('k2', 'Plain Thing', {
                    canonical_model_id: 'vendor/x',
                    reasoning: true,
                }),
            }),
        });

        expect(catalog.models['vendor/x']?.name).toBe('Thinking Thing');
    });

    it('user sees the shorter relay key kept when two copies carry the same details', () => {
        const catalog = buildCatalog({
            relayA: provider({
                'a-much-longer-key': model('long', 'Long Key Thing', {
                    canonical_model_id: 'vendor/x',
                }),
            }),
            relayB: provider({
                short: model('short', 'Short Key Thing', {
                    canonical_model_id: 'vendor/x',
                }),
            }),
        });

        expect(catalog.models['vendor/x']?.name).toBe('Short Key Thing');
    });

    it('user sees the alphabetically first relay key kept when two copies are identical', () => {
        const catalog = buildCatalog({
            relayA: provider({
                kb: model('b', 'Beta Thing', { canonical_model_id: 'vendor/x' }),
            }),
            relayB: provider({
                ka: model('a', 'Alpha Thing', { canonical_model_id: 'vendor/x' }),
            }),
        });

        expect(catalog.models['vendor/x']?.name).toBe('Alpha Thing');
    });

    it('user loses no models when one provider payload is not a catalog', () => {
        const catalog = buildCatalog({
            broken: { models: 'not a catalog' },
            openai: provider({
                'gpt-4o': model('gpt-4o', 'GPT-4o'),
            }),
        });

        expect(Object.keys(catalog.models)).toEqual(['gpt-4o']);
    });

    it('user sees a model the upstream gave no canonical id recorded under its own key', () => {
        const catalog = buildCatalog({
            openai: provider({
                'GPT-4O': model('GPT-4O', 'GPT-4o'),
            }),
        });

        expect(Object.keys(catalog.models)).toEqual(['gpt-4o']);
        expect(catalog.alias['gpt-4o']).toBe('gpt-4o');
    });

    it('user reaches a renamed model through the spelling a relay uses', () => {
        const catalog = buildCatalog({
            deepseek: provider({
                'deepseek-chat': model('deepseek-chat', 'DeepSeek Chat', {
                    canonical_model_id: 'deepseek/deepseek-v4',
                }),
            }),
            relay: provider({
                'ds-chat': model('ds-chat', 'DS Chat', {
                    canonical_model_id: 'deepseek/deepseek-v4',
                }),
            }),
        });

        expect(catalog.alias['ds-chat']).toBe('deepseek/deepseek-v4');
        expect(catalog.alias['deepseek-chat']).toBe('deepseek/deepseek-v4');
        expect(catalog.alias['deepseek-v4']).toBe('deepseek/deepseek-v4');
    });

    it('user sees two models with the same key kept as one cache entry', () => {
        const catalog = buildCatalog({
            a: provider({ shared: model('shared-a', 'Shared A') }),
            b: provider({ shared: model('shared-b', 'Shared B') }),
        });

        // Both providers spell the model the same way, so there is one cache entry for it.
        expect(Object.keys(catalog.models)).toEqual(['shared']);
        expect(catalog.alias['shared']).toBe('shared');
    });

    it('user gets the model family usable as a catalog alias', () => {
        const catalog = buildCatalog({
            openai: provider({
                'gpt-4o': model('gpt-4o', 'GPT-4o', { family: 'gpt-4o-family' }),
            }),
        });

        expect(catalog.alias['gpt-4o-family']).toBe('gpt-4o');
    });

    it('user never gets a blank alias entry', () => {
        const catalog = buildCatalog({
            openai: provider({
                '': model('no-key', 'No Key', { canonical_model_id: 'openai/ghost' }),
            }),
        });

        expect(Object.keys(catalog.alias)).not.toContain('');
        expect(Object.keys(catalog.alias).every((alias) => alias.length > 0)).toBe(true);
    });

    it('user sees an already curated catalog passed through untouched', () => {
        const catalog = buildCatalog({
            models: {
                'vendor/thing': model('thing', 'Thing', { attachment: true }),
            },
            alias: { thing: 'vendor/thing' },
        });

        expect(Object.keys(catalog.models)).toEqual(['vendor/thing']);
        expect(catalog.alias).toEqual({ thing: 'vendor/thing' });
    });
});

describe('user imports model metadata into the local cache', () => {
    it('user sees one row per model with its capabilities flagged', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', {
                    attachment: true,
                    reasoning: true,
                    tool_call: true,
                    temperature: false,
                    open_weights: true,
                    modalities: { input: ['text', 'image'], output: ['text'] },
                    knowledge: '2025-01',
                    release_date: '2025-02-01',
                }),
            },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')).toMatchObject({
            name: 'Thing',
            attachment: 1,
            reasoning: 1,
            tool_call: 1,
            temperature: 0,
            open_weights: 1,
            modalities: '{"input":["text","image"],"output":["text"]}',
            knowledge: '2025-01',
            release_date: '2025-02-01',
        });
    });

    it('user sees text-only modalities recorded for a model that never declares any', () => {
        const { metadataList } = buildMetadataList({
            models: { 'vendor/thing': model('thing', 'Thing') },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')?.modalities).toBe(
            '{"input":["text"],"output":["text"]}'
        );
    });

    it('user sees the model limits stored as one readable value', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', {
                    limit: { context: 128000, output: 16384 },
                }),
            },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')?.limit).toBe(
            '{"context":128000,"output":16384}'
        );
    });

    it('user gets no limit recorded when the upstream limits are unusable', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', {
                    limit: { context: -5, output: 'lots' },
                }),
            },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')?.limit).toBeNull();
    });

    it('user gets no reasoning options recorded when the upstream declares none', () => {
        const { metadataList } = buildMetadataList({
            models: { 'vendor/thing': model('thing', 'Thing', { reasoning: false }) },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')?.reasoning_options).toBeNull();
    });

    it('user sees the reasoning levels the upstream offers kept for the model', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', {
                    reasoning: true,
                    reasoning_options: [
                        { type: 'effort', values: ['low', 'high'] },
                        { type: 'nonsense' },
                        { type: 'toggle' },
                    ],
                }),
            },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')?.reasoning_options).toBe(
            '[{"type":"effort","values":["low","high"]},{"type":"toggle"}]'
        );
    });

    it('user sees per-million prices split into their own columns', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', {
                    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
                }),
            },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')).toMatchObject({
            input_cost_per_million: '3',
            output_cost_per_million: '15',
            cache_read_cost_per_million: '0.3',
            cache_write_cost_per_million: '3.75',
            cost_currency: 'USD',
        });
    });

    it('user sees the reasoning price left empty so it can follow the output price', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', { cost: { output: 15 } }),
            },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')).toMatchObject({
            output_cost_per_million: '15',
            reasoning_cost_per_million: null,
        });
    });

    it('user sees prices kept in the currency the upstream quotes', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', { cost: { input: 1, currency: 'EUR' } }),
            },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')?.cost_currency).toBe('EUR');
    });

    it('user sees an unpriced model recorded as costing nothing known', () => {
        const { metadataList } = buildMetadataList({
            models: { 'vendor/thing': model('thing', 'Thing') },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')).toMatchObject({
            input_cost_per_million: null,
            output_cost_per_million: null,
            cache_read_cost_per_million: null,
            cache_write_cost_per_million: null,
            reasoning_cost_per_million: null,
            cost_currency: null,
            cost_tiers: null,
        });
    });

    it('user sees long-context price steps kept in ascending order', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', {
                    cost: {
                        input: 3,
                        output: 15,
                        tiers: [
                            { input: 6, output: 22.5, cache_read: 0.6, tier: { size: 200000 } },
                            { tier: { size: 0 } },
                            { input: 9, tier: { type: 'batch', size: 500000 } },
                            { input: 1.5, tier: { type: 'context', size: 100000 } },
                        ],
                    },
                }),
            },
            alias: {},
        });

        const payload = JSON.parse(String(metadataFor(metadataList, 'vendor/thing')?.cost_tiers));
        expect(payload).toEqual([
            {
                above: 100000,
                input: 1.5,
                output: null,
                cacheRead: null,
                cacheWrite: null,
                reasoning: null,
            },
            {
                above: 200000,
                input: 6,
                output: 22.5,
                cacheRead: 0.6,
                cacheWrite: null,
                reasoning: null,
            },
        ]);
    });

    it('user sees no price steps recorded when every step is unusable', () => {
        const { metadataList } = buildMetadataList({
            models: {
                'vendor/thing': model('thing', 'Thing', {
                    cost: { input: 3, tiers: [{ tier: { size: 0 } }, { input: 9 }] },
                }),
            },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')?.cost_tiers).toBeNull();
    });

    it('user sees the model name derived from its key when the upstream omits one', () => {
        const { metadataList } = buildMetadataList({
            models: { 'vendor/thing': model('thing', 'Relay Friendly Name') },
            alias: {},
        });

        expect(metadataFor(metadataList, 'vendor/thing')?.name).toBe('Relay Friendly Name');
    });

    it('user reaches the stored model through each spelling it was listed under', () => {
        const { aliasList } = buildMetadataList({
            deepseek: provider({
                'deepseek-chat': model('deepseek-chat', 'DeepSeek Chat', {
                    canonical_model_id: 'deepseek/deepseek-v4',
                }),
            }),
            relay: provider({
                'ds-chat': model('ds-chat', 'DS Chat', {
                    canonical_model_id: 'deepseek/deepseek-v4',
                }),
            }),
        });

        expect(aliasList).toEqual(
            expect.arrayContaining([
                { alias: 'deepseek-chat', model_id: 'deepseek/deepseek-v4' },
                { alias: 'ds-chat', model_id: 'deepseek/deepseek-v4' },
                { alias: 'deepseek-v4', model_id: 'deepseek/deepseek-v4' },
                { alias: 'deepseek/deepseek-v4', model_id: 'deepseek/deepseek-v4' },
            ])
        );
    });

    it('user keeps the upstream alias table when the catalog ships one', () => {
        const { aliasList, metadataList } = buildMetadataList({
            models: { 'vendor/thing': model('thing', 'Thing') },
            alias: { thing: 'vendor/thing' },
        });

        expect(metadataList).toHaveLength(1);
        expect(aliasList).toEqual([{ alias: 'thing', model_id: 'vendor/thing' }]);
    });

    it('user never gets an alias pointing at a model the cache does not hold', () => {
        const { aliasList } = buildMetadataList({
            models: { 'vendor/thing': model('thing', 'Thing') },
            alias: {
                thing: 'vendor/thing',
                ghost: 'vendor/missing',
            },
        });

        expect(aliasList).toEqual([{ alias: 'thing', model_id: 'vendor/thing' }]);
    });

    it('user keeps the cached models when an empty catalog arrives', () => {
        expect(() => buildMetadataList({ models: {}, alias: {} })).toThrow(
            'Refusing to replace model metadata with an empty catalog'
        );
    });

    it('user keeps the cached models when the catalog holds no usable provider', () => {
        expect(() =>
            buildMetadataList({ broken: { models: 'not a catalog' }, empty: provider({}) })
        ).toThrow('Refusing to replace model metadata with an empty catalog');
    });
});
