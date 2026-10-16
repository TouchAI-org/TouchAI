#!/usr/bin/env node
/**
 * Refreshes the bundled model metadata snapshot at
 * src/services/AgentService/infrastructure/modelMetadata/snapshot.json.
 *
 * The snapshot is the boot-time floor for the model catalog when the local
 * cache is empty and the live fetch is unavailable; a successful live fetch
 * still refreshes on top of it.
 *
 * Upstream is models.dev: a payload keyed by provider where an entry may carry
 * `canonical_model_id` pointing at the record that owns the model. The snapshot
 * is rebuilt into two layers — one record per model, plus an alias table that
 * maps every provider spelling back to that record — so a relay that renames
 * `deepseek-v4.1-flash` still resolves to the DeepSeek record.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL_METADATA_SOURCE_URL = 'https://models.dev/api.json';

export const MODEL_METADATA_SNAPSHOT_PATH =
    'src/services/AgentService/infrastructure/modelMetadata/snapshot.json';

// 下限而非等值：防止把错误页或截断的响应写进快照。
const MINIMUM_MODELS = 1200;
const MINIMUM_ALIASES = 2500;

/** 只保留运行时真正读取的字段，其余上游字段（cost、description 等）一律丢弃。 */
const RETAINED_MODEL_FIELDS = [
    'id',
    'name',
    'family',
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

/** 从模型名推导出来的别名优先级最低，避免盖掉真实收录方的写法。 */
const DERIVED_ALIAS_PRIORITY = 2000;
const FAMILY_ALIAS_PRIORITY = 5000;

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownerSegmentOf(canonicalId) {
    const separatorIndex = canonicalId.indexOf('/');
    return separatorIndex === -1 ? canonicalId : canonicalId.slice(0, separatorIndex);
}

function nameSegmentOf(canonicalId) {
    const separatorIndex = canonicalId.indexOf('/');
    return separatorIndex === -1 ? '' : canonicalId.slice(separatorIndex + 1);
}

function retainedFieldCount(model) {
    let count = 0;

    for (const field of RETAINED_MODEL_FIELDS) {
        if (model[field] !== undefined) {
            count += 1;
        }
    }

    if (Array.isArray(model.reasoning_options) && model.reasoning_options.length > 0) {
        count += 2;
    }

    return count;
}

/** 归属 provider 自己的条目优先，其次才是别家转载的条目。 */
function sourcePriority(entry) {
    const owner = ownerSegmentOf(entry.canonicalId);
    const name = nameSegmentOf(entry.canonicalId);

    if (entry.providerId === owner && entry.modelKey === name) {
        return 0;
    }

    if (entry.providerId === owner) {
        return 1;
    }

    if (entry.modelKey === name) {
        return 2;
    }

    return 3;
}

/** 别名优先级：官方写法 > 其他收录方写法 > 从模型名推导的写法。 */
function aliasPriority(entry, providerIds) {
    const owner = ownerSegmentOf(entry.canonicalId);
    const name = nameSegmentOf(entry.canonicalId);
    let priority = 0;

    if (entry.providerId !== owner) {
        priority += 1000;
    }

    if (entry.modelKey !== name) {
        priority += 100;
    }

    if (!providerIds.has(owner)) {
        priority += 10;
    }

    return priority;
}

function sortedRecord(entries) {
    const record = {};

    for (const [key, value] of entries.sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
    )) {
        record[key] = value;
    }

    return record;
}

/**
 * 把 models.dev 的原始目录整理成「模型表 + 别名表」。
 *
 * 模型表按 canonical id 去重，同一模型有多家收录时保留官方条目；
 * 别名表保留所有收录方的写法，让中转站的自定义命名也能命中。
 */
export function buildCatalog(rawCatalog) {
    if (!isPlainObject(rawCatalog)) {
        throw new Error('Model metadata payload must be an object keyed by provider id.');
    }

    const groups = new Map();

    for (const [providerId, provider] of Object.entries(rawCatalog)) {
        if (!isPlainObject(provider) || !isPlainObject(provider.models)) {
            continue;
        }

        for (const [modelKey, model] of Object.entries(provider.models)) {
            if (!isPlainObject(model)) {
                continue;
            }

            const canonicalId =
                typeof model.canonical_model_id === 'string' && model.canonical_model_id
                    ? model.canonical_model_id
                    : modelKey.toLowerCase();

            const entries = groups.get(canonicalId) ?? [];
            entries.push({ providerId, modelKey, model, canonicalId });
            groups.set(canonicalId, entries);
        }
    }

    const providerIds = new Set(Object.keys(rawCatalog));
    const models = new Map();
    const aliasCandidates = new Map();

    const offerAlias = (alias, canonicalId, priority) => {
        if (typeof alias !== 'string' || alias.length === 0) {
            return;
        }

        const key = alias.toLowerCase();
        const current = aliasCandidates.get(key);

        if (current) {
            if (current.priority < priority) {
                return;
            }

            if (current.priority === priority && current.canonicalId <= canonicalId) {
                return;
            }
        }

        aliasCandidates.set(key, { canonicalId, priority });
    };

    for (const [canonicalId, entries] of groups) {
        entries.sort((left, right) => {
            const leftPriority = sourcePriority(left);
            const rightPriority = sourcePriority(right);

            if (leftPriority !== rightPriority) {
                return leftPriority - rightPriority;
            }

            const leftFields = retainedFieldCount(left.model);
            const rightFields = retainedFieldCount(right.model);

            if (leftFields !== rightFields) {
                return rightFields - leftFields;
            }

            if (left.modelKey.length !== right.modelKey.length) {
                return left.modelKey.length - right.modelKey.length;
            }

            return left.modelKey < right.modelKey ? -1 : left.modelKey > right.modelKey ? 1 : 0;
        });

        const source = entries[0];
        const record = {};

        for (const field of RETAINED_MODEL_FIELDS) {
            if (source.model[field] !== undefined) {
                record[field] = source.model[field];
            }
        }

        models.set(canonicalId, record);

        for (const entry of entries) {
            const priority = aliasPriority(entry, providerIds);
            offerAlias(entry.modelKey, canonicalId, priority);
            offerAlias(entry.model.id, canonicalId, priority + 1);
        }

        const derivedPriority =
            DERIVED_ALIAS_PRIORITY + (providerIds.has(ownerSegmentOf(canonicalId)) ? 0 : 10);
        offerAlias(nameSegmentOf(canonicalId) || canonicalId, canonicalId, derivedPriority);
        offerAlias(canonicalId, canonicalId, derivedPriority + 1);

        if (typeof source.model.family === 'string') {
            offerAlias(source.model.family, canonicalId, FAMILY_ALIAS_PRIORITY);
        }
    }

    const alias = new Map();
    for (const [key, candidate] of aliasCandidates) {
        alias.set(key, candidate.canonicalId);
    }

    return {
        models: sortedRecord([...models]),
        alias: sortedRecord([...alias]),
    };
}

export function countCatalog(catalog) {
    return {
        models: Object.keys(catalog.models).length,
        aliases: Object.keys(catalog.alias).length,
    };
}

export function assertCatalogFloor(catalog) {
    const counts = countCatalog(catalog);

    if (counts.models < MINIMUM_MODELS || counts.aliases < MINIMUM_ALIASES) {
        throw new Error(
            `Refusing to write a truncated snapshot: got ${counts.models} models / ` +
                `${counts.aliases} aliases, expected at least ${MINIMUM_MODELS} models and ` +
                `${MINIMUM_ALIASES} aliases.`
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

    const catalog = buildCatalog(await response.json());
    const counts = assertCatalogFloor(catalog);

    const targetPath = join(projectRoot, MODEL_METADATA_SNAPSHOT_PATH);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

    return { targetPath, ...counts };
}

async function main() {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const { targetPath, models, aliases } = await updateModelMetadataSnapshot({ projectRoot });

    console.log(`Wrote ${models} models / ${aliases} aliases to ${targetPath}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
