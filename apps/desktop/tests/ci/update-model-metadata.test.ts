import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    assertCatalogFloor,
    buildCatalog,
    countCatalog,
    MODEL_METADATA_SNAPSHOT_PATH,
    updateModelMetadataSnapshot,
} from '../../scripts/update-model-metadata.mjs';

type ProviderCatalog = Record<string, { models: Record<string, Record<string, unknown>> }>;

function model(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, name: id, reasoning: true, ...extra };
}

function buildCatalogFixture(modelCount: number, providerCount = 2): ProviderCatalog {
    const catalog: ProviderCatalog = {};

    for (let providerIndex = 0; providerIndex < providerCount; providerIndex += 1) {
        const models: Record<string, Record<string, unknown>> = {};

        for (let modelIndex = 0; modelIndex < modelCount; modelIndex += 1) {
            const id = `provider-${providerIndex}-model-${modelIndex}`;
            models[id] = model(id, { canonical_model_id: `provider-${providerIndex}/${id}` });
        }

        catalog[`provider-${providerIndex}`] = { models };
    }

    return catalog;
}

async function withTempProjectRoot(run: (projectRoot: string) => Promise<void>): Promise<void> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'touchai-model-metadata-'));
    try {
        await run(projectRoot);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
}

describe('update model metadata snapshot', () => {
    it('retains the fields the runtime reads', () => {
        const catalog = buildCatalog({
            openai: {
                models: {
                    'gpt-5.2': {
                        id: 'gpt-5.2',
                        name: 'GPT-5.2',
                        reasoning: true,
                        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
                        cost: { input: 1 },
                        description: 'not retained',
                    },
                },
            },
        });

        expect(catalog.models['gpt-5.2']).toEqual({
            id: 'gpt-5.2',
            name: 'GPT-5.2',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            // 定价是成本统计的唯一来源，必须一起带进快照，
            // 否则离线兜底数据算不出任何金额。
            cost: { input: 1 },
        });
    });

    it('keeps one record per canonical model and prefers the owning provider', () => {
        const catalog = buildCatalog({
            deepseek: {
                models: {
                    'deepseek-flash': {
                        id: 'deepseek-flash',
                        name: 'DeepSeek Flash',
                        reasoning: true,
                        limit: { context: 1000000 },
                        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
                    },
                },
            },
            relay: {
                models: {
                    'deepseek-v4.1-flash': {
                        id: 'deepseek-v4.1-flash',
                        name: 'DeepSeek V4.1 Flash',
                        reasoning: true,
                        limit: { context: 1 },
                        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
                    },
                },
            },
        });

        expect(Object.keys(catalog.models)).toEqual(['deepseek/deepseek-v4.1-flash']);
        expect(catalog.models['deepseek/deepseek-v4.1-flash']?.limit).toEqual({ context: 1000000 });
        expect(catalog.alias['deepseek-v4.1-flash']).toBe('deepseek/deepseek-v4.1-flash');
        expect(catalog.alias['deepseek-flash']).toBe('deepseek/deepseek-v4.1-flash');
    });

    it('resolves relay spellings of a model to the record that owns it', () => {
        const catalog = buildCatalog({
            deepseek: {
                models: {
                    'deepseek-flash': {
                        id: 'deepseek-flash',
                        name: 'DeepSeek V4.1 Flash',
                        reasoning: true,
                        reasoning_options: [
                            { type: 'toggle' },
                            { type: 'effort', values: ['low', 'high', 'max'] },
                        ],
                        limit: { context: 1000000, output: 393216 },
                        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
                    },
                },
            },
            relay: {
                models: {
                    'deepseek-ai/DeepSeek-V4.1-Flash': {
                        id: 'deepseek-ai/DeepSeek-V4.1-Flash',
                        name: 'DeepSeek V4.1 Flash',
                        reasoning: true,
                        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
                    },
                },
            },
        });

        expect(catalog.models['deepseek/deepseek-v4.1-flash']?.reasoning_options).toEqual([
            { type: 'toggle' },
            { type: 'effort', values: ['low', 'high', 'max'] },
        ]);
        expect(catalog.alias['deepseek-ai/deepseek-v4.1-flash']).toBe(
            'deepseek/deepseek-v4.1-flash'
        );
        expect(catalog.alias['deepseek-flash']).toBe('deepseek/deepseek-v4.1-flash');
    });

    it('falls back to the model key when an entry has no canonical id', () => {
        const catalog = buildCatalog({
            openai: {
                models: {
                    'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2', reasoning: true },
                },
            },
        });

        expect(Object.keys(catalog.models)).toEqual(['gpt-5.2']);
        expect(catalog.alias['gpt-5.2']).toBe('gpt-5.2');
    });

    it('skips malformed providers and models instead of failing the whole refresh', () => {
        const catalog = buildCatalog({
            broken: 'not a provider',
            empty: {},
            openai: {
                models: {
                    'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2' },
                    broken: null,
                },
            },
        });

        expect(Object.keys(catalog.models)).toEqual(['gpt-5.2']);
    });

    it('rejects payloads that are not keyed by provider id', () => {
        expect(() => buildCatalog([{ models: {} }])).toThrow(
            'Model metadata payload must be an object keyed by provider id.'
        );
    });

    it('counts models and aliases across the catalog', () => {
        expect(countCatalog(buildCatalog(buildCatalogFixture(3)))).toEqual({
            models: 6,
            aliases: 12,
        });
    });

    it('refuses to write a truncated catalog', () => {
        expect(() => assertCatalogFloor(buildCatalog(buildCatalogFixture(1)))).toThrow(
            /Refusing to write a truncated snapshot/
        );
    });

    it('writes the snapshot relative to the project root', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            const fetchImpl = (async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => buildCatalogFixture(1000, 2),
            })) as unknown as typeof fetch;

            const result = await updateModelMetadataSnapshot({
                projectRoot,
                sourceUrl: 'https://example.test/api.json',
                fetchImpl,
            });

            expect(result.targetPath).toBe(join(projectRoot, MODEL_METADATA_SNAPSHOT_PATH));
            expect(result.models).toBe(2000);
            expect(result.aliases).toBe(4000);

            const written = JSON.parse(await readFile(result.targetPath, 'utf8')) as {
                models: Record<string, unknown>;
                alias: Record<string, string>;
            };
            expect(Object.keys(written.models)).toHaveLength(2000);
            expect(written.models['provider-0/provider-0-model-0']).toEqual({
                id: 'provider-0-model-0',
                name: 'provider-0-model-0',
                reasoning: true,
            });
        });
    });

    it('leaves the existing snapshot untouched when the fetched catalog is truncated', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            const fetchImpl = (async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => buildCatalogFixture(1),
            })) as unknown as typeof fetch;

            await expect(
                updateModelMetadataSnapshot({
                    projectRoot,
                    sourceUrl: 'https://example.test/api.json',
                    fetchImpl,
                })
            ).rejects.toThrow('Refusing to write a truncated snapshot');

            await expect(
                readFile(join(projectRoot, MODEL_METADATA_SNAPSHOT_PATH), 'utf8')
            ).rejects.toThrow();
        });
    });

    it('fails when the source responds with an error status', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            await expect(
                updateModelMetadataSnapshot({
                    projectRoot,
                    sourceUrl: 'https://example.test/api.json',
                    fetchImpl: (async () => ({
                        ok: false,
                        status: 503,
                        statusText: 'Service Unavailable',
                    })) as unknown as typeof fetch,
                })
            ).rejects.toThrow(
                'Failed to fetch https://example.test/api.json: 503 Service Unavailable'
            );
        });
    });
});
