import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { refreshModelMetadataSnapshot } from '../../scripts/ci/refresh-model-metadata-snapshot.mjs';
import { MODEL_METADATA_SNAPSHOT_PATH } from '../../scripts/update-model-metadata.mjs';

type ProviderCatalog = Record<string, { models: Record<string, Record<string, unknown>> }>;

function buildCatalog(providerCount: number, modelsPerProvider: number): ProviderCatalog {
    const catalog: ProviderCatalog = {};

    for (let providerIndex = 0; providerIndex < providerCount; providerIndex += 1) {
        const models: Record<string, Record<string, unknown>> = {};

        for (let modelIndex = 0; modelIndex < modelsPerProvider; modelIndex += 1) {
            const id = `provider-${providerIndex}-model-${modelIndex}`;
            models[id] = {
                id,
                name: id,
                reasoning: true,
                canonical_model_id: `provider-${providerIndex}/${id}`,
            };
        }

        catalog[`provider-${providerIndex}`] = { models };
    }

    return catalog;
}

function jsonResponse(catalog: unknown): typeof fetch {
    return (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => catalog,
    })) as unknown as typeof fetch;
}

async function withTempProjectRoot(run: (projectRoot: string) => Promise<void>): Promise<void> {
    const projectRoot = await mkdtemp(join(tmpdir(), 'touchai-model-metadata-refresh-'));
    try {
        await run(projectRoot);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
}

async function seedSnapshot(projectRoot: string, content: string): Promise<string> {
    const targetPath = join(projectRoot, MODEL_METADATA_SNAPSHOT_PATH);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
    return targetPath;
}

describe('refresh model metadata snapshot', () => {
    it('writes the snapshot and reports it as updated', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            const result = await refreshModelMetadataSnapshot({
                projectRoot,
                sourceUrl: 'https://example.test/api.json',
                fetchImpl: jsonResponse(buildCatalog(40, 100)),
            });

            expect(result.status).toBe('updated');
            expect(result.models).toBe(4000);
            expect(result.aliases).toBe(8000);
            expect(result.digest).toMatch(/^[0-9a-f]{64}$/);

            const written = JSON.parse(
                await readFile(join(projectRoot, MODEL_METADATA_SNAPSHOT_PATH), 'utf8')
            ) as { models: Record<string, unknown> };
            expect(Object.keys(written.models)).toHaveLength(4000);
        });
    });

    it('reports an unchanged snapshot when the catalog matches the branch copy', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            const fetchImpl = jsonResponse(buildCatalog(40, 100));
            const options = { projectRoot, sourceUrl: 'https://example.test/api.json', fetchImpl };

            const first = await refreshModelMetadataSnapshot(options);
            const second = await refreshModelMetadataSnapshot(options);

            expect(first.status).toBe('updated');
            expect(second.status).toBe('unchanged');
            expect(second.digest).toBe(first.digest);
        });
    });

    it('keeps the existing snapshot when the upstream fetch fails', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            const targetPath = await seedSnapshot(projectRoot, '{ "existing": true }\n');

            const result = await refreshModelMetadataSnapshot({
                projectRoot,
                sourceUrl: 'https://example.test/api.json',
                fetchImpl: (async () => {
                    throw new Error('network down');
                }) as unknown as typeof fetch,
            });

            expect(result.status).toBe('skipped');
            expect(result.reason).toContain('network down');
            expect(await readFile(targetPath, 'utf8')).toBe('{ "existing": true }\n');
        });
    });

    it('keeps the existing snapshot when the upstream catalog is truncated', async () => {
        await withTempProjectRoot(async (projectRoot) => {
            const targetPath = await seedSnapshot(projectRoot, '{ "existing": true }\n');

            const result = await refreshModelMetadataSnapshot({
                projectRoot,
                sourceUrl: 'https://example.test/api.json',
                fetchImpl: jsonResponse(buildCatalog(1, 1)),
            });

            expect(result.status).toBe('skipped');
            expect(result.reason).toContain('Refusing to write a truncated snapshot');
            expect(await readFile(targetPath, 'utf8')).toBe('{ "existing": true }\n');
        });
    });
});
