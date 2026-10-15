import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    assertCatalogFloor,
    countCatalog,
    MODEL_METADATA_SNAPSHOT_PATH,
    trimCatalog,
    updateModelMetadataSnapshot,
} from '../../scripts/update-model-metadata.mjs';

type Catalog = Record<string, { models: Record<string, Record<string, unknown>> }>;

function buildCatalog(providerCount: number, modelsPerProvider: number): Catalog {
    const catalog: Catalog = {};

    for (let providerIndex = 0; providerIndex < providerCount; providerIndex += 1) {
        const models: Record<string, Record<string, unknown>> = {};

        for (let modelIndex = 0; modelIndex < modelsPerProvider; modelIndex += 1) {
            const id = `provider-${providerIndex}-model-${modelIndex}`;
            models[id] = {
                id,
                name: id,
                reasoning: true,
                cost: { input: 1 },
                description: 'not retained',
            };
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
    it('retains only the fields the runtime reads', () => {
        const catalog = trimCatalog({
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

        expect(catalog).toEqual({
            openai: {
                models: {
                    'gpt-5.2': {
                        id: 'gpt-5.2',
                        name: 'GPT-5.2',
                        reasoning: true,
                        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
                    },
                },
            },
        });
    });

    it('skips malformed providers and models instead of failing the whole refresh', () => {
        const catalog = trimCatalog({
            broken: 'not a provider',
            empty: {},
            openai: {
                models: {
                    'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2' },
                    broken: null,
                },
            },
        });

        expect(catalog).toEqual({
            openai: { models: { 'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2' } } },
        });
    });

    it('rejects payloads that are not keyed by provider id', () => {
        expect(() => trimCatalog([{ models: {} }])).toThrow(
            'Model metadata payload must be an object keyed by provider id.'
        );
    });

    it('counts providers and models across the catalog', () => {
        expect(countCatalog(buildCatalog(3, 4))).toEqual({ providers: 3, models: 12 });
    });

    it('refuses to write a truncated catalog', () => {
        expect(() => assertCatalogFloor(buildCatalog(1, 1))).toThrow(
            /Refusing to write a truncated snapshot/
        );
        expect(assertCatalogFloor(buildCatalog(40, 10))).toEqual({ providers: 40, models: 400 });
    });

    it('writes the snapshot relative to the project root', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            const result = await updateModelMetadataSnapshot({
                projectRoot,
                sourceUrl: 'https://example.test/api.json',
                fetchImpl: (async () => ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => buildCatalog(40, 10),
                })) as unknown as typeof fetch,
            });

            expect(result).toEqual({
                targetPath: join(projectRoot, MODEL_METADATA_SNAPSHOT_PATH),
                providers: 40,
                models: 400,
            });

            const written = JSON.parse(await readFile(result.targetPath, 'utf8')) as Catalog;
            expect(Object.keys(written)).toHaveLength(40);
            expect(written['provider-0']?.models['provider-0-model-0']).toEqual({
                id: 'provider-0-model-0',
                name: 'provider-0-model-0',
                reasoning: true,
            });
        });
    });

    it('leaves the existing snapshot untouched when the fetched catalog is truncated', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            await expect(
                updateModelMetadataSnapshot({
                    projectRoot,
                    sourceUrl: 'https://example.test/api.json',
                    fetchImpl: (async () => ({
                        ok: true,
                        status: 200,
                        statusText: 'OK',
                        json: async () => buildCatalog(1, 1),
                    })) as unknown as typeof fetch,
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
