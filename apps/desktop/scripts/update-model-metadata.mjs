#!/usr/bin/env node
/**
 * Refreshes the bundled model metadata snapshot at
 * src/services/AgentService/infrastructure/modelMetadata/snapshot.json.
 *
 * The snapshot is the boot-time floor for the model catalog when the local
 * cache is empty and the live fetch is unavailable; a successful live fetch
 * still refreshes on top of it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL_METADATA_SOURCE_URL = 'https://llm-metadata.pages.dev/api/all.json';

export const MODEL_METADATA_SNAPSHOT_PATH =
    'src/services/AgentService/infrastructure/modelMetadata/snapshot.json';

// 下限而非等值：防止把错误页或截断的响应写进快照。
const MINIMUM_PROVIDERS = 40;
const MINIMUM_MODELS = 400;

/** 只保留运行时真正读取的字段，其余上游字段（cost、description 等）一律丢弃。 */
const RETAINED_MODEL_FIELDS = [
    'id',
    'name',
    'attachment',
    'modalities',
    'open_weights',
    'reasoning',
    'release_date',
    'temperature',
    'tool_call',
    'knowledge',
    'limit',
    'reasoning_options',
];

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function trimCatalog(rawCatalog) {
    if (!isPlainObject(rawCatalog)) {
        throw new Error('Model metadata payload must be an object keyed by provider id.');
    }

    const catalog = {};

    for (const [providerId, provider] of Object.entries(rawCatalog)) {
        if (!isPlainObject(provider) || !isPlainObject(provider.models)) {
            continue;
        }

        const models = {};
        for (const [modelKey, model] of Object.entries(provider.models)) {
            if (!isPlainObject(model)) {
                continue;
            }

            const retained = {};
            for (const field of RETAINED_MODEL_FIELDS) {
                if (model[field] !== undefined) {
                    retained[field] = model[field];
                }
            }
            models[modelKey] = retained;
        }

        catalog[providerId] = { models };
    }

    return catalog;
}

export function countCatalog(catalog) {
    return {
        providers: Object.keys(catalog).length,
        models: Object.values(catalog).reduce(
            (total, provider) => total + Object.keys(provider.models).length,
            0
        ),
    };
}

export function assertCatalogFloor(catalog) {
    const counts = countCatalog(catalog);

    if (counts.providers < MINIMUM_PROVIDERS || counts.models < MINIMUM_MODELS) {
        throw new Error(
            `Refusing to write a truncated snapshot: got ${counts.providers} providers / ` +
                `${counts.models} models, expected at least ${MINIMUM_PROVIDERS} providers and ` +
                `${MINIMUM_MODELS} models.`
        );
    }

    return counts;
}

export async function updateModelMetadataSnapshot({
    projectRoot,
    sourceUrl = MODEL_METADATA_SOURCE_URL,
    fetchImpl = fetch,
} = {}) {
    const response = await fetchImpl(sourceUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${sourceUrl}: ${response.status} ${response.statusText}`);
    }

    const catalog = trimCatalog(await response.json());
    const counts = assertCatalogFloor(catalog);

    const targetPath = join(projectRoot, MODEL_METADATA_SNAPSHOT_PATH);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

    return { targetPath, ...counts };
}

async function main() {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const { targetPath, providers, models } = await updateModelMetadataSnapshot({ projectRoot });

    console.log(`Wrote ${providers} providers / ${models} models to ${targetPath}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
