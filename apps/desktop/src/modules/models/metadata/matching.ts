import { expandModelIdCandidates } from '@touchai/models/catalog';

interface UpstreamModelMetadataPatch {
    context_limit?: number;
    output_limit?: number;
    modalities?: string;
    attachment?: number;
    reasoning?: number;
    reasoning_options?: string;
    tool_call?: number;
}

export interface ModelMetadataTarget {
    id: number;
    modelId: string;
}

/** 运行时模型行，带上一次上游 `/v1/models` 记录的能力声明。 */
export interface ModelMetadataTargetRow extends ModelMetadataTarget {
    upstreamMetadata: string | null;
}

export interface ModelMetadataUpdateRow {
    id: number;
    attachment: number | null;
    modalities: string | null;
    open_weights: number | null;
    reasoning: number | null;
    reasoning_options: string | null;
    release_date: string | null;
    temperature: number | null;
    tool_call: number | null;
    knowledge: string | null;
    context_limit: number | null;
    output_limit: number | null;
    clear_reasoning_options: number;
}

export interface LlmMetadataRecord {
    modelId: string;
    attachment: number;
    modalities: string;
    openWeights: number;
    reasoning: number;
    reasoningOptions: string | null;
    releaseDate: string | null;
    temperature: number;
    toolCall: number;
    knowledge: string | null;
    contextLimit: number | null;
    outputLimit: number | null;
}

export interface ModelMetadataSelection {
    modelRowId: number;
    metadata: LlmMetadataRecord;
}

/** 声明得越多的条目越可信。 */
function metadataRichness(record: LlmMetadataRecord): number {
    return (
        record.attachment +
        record.openWeights +
        record.reasoning +
        record.temperature +
        record.toolCall +
        (record.modalities.length > 0 ? 1 : 0)
    );
}

interface RankedMatch {
    depth: number;
    metadata: LlmMetadataRecord;
}

/** 选优：裁剪最少 > 元数据最全 > model_id 最长，全并列时取字典序保证稳定。 */
function isBetterMatch(candidate: RankedMatch, current: RankedMatch): boolean {
    if (candidate.depth !== current.depth) {
        return candidate.depth < current.depth;
    }

    const candidateScore = metadataRichness(candidate.metadata);
    const currentScore = metadataRichness(current.metadata);
    if (candidateScore !== currentScore) {
        return candidateScore > currentScore;
    }

    if (candidate.metadata.modelId.length !== current.metadata.modelId.length) {
        return candidate.metadata.modelId.length > current.metadata.modelId.length;
    }

    return candidate.metadata.modelId < current.metadata.modelId;
}

/** 为每个模型行选出最可信的元数据条目；没有候选命中别名表时跳过该行。 */
export function selectModelMetadata(
    targets: readonly ModelMetadataTarget[],
    aliasTargets: ReadonlyMap<string, string>,
    metadataByModelId: ReadonlyMap<string, LlmMetadataRecord>
): ModelMetadataSelection[] {
    const selections: ModelMetadataSelection[] = [];

    for (const target of targets) {
        let best: RankedMatch | null = null;

        for (const { candidate, depth } of expandModelIdCandidates(target.modelId)) {
            const metadataModelId = aliasTargets.get(candidate);
            if (!metadataModelId) {
                continue;
            }

            const metadata = metadataByModelId.get(metadataModelId);
            if (!metadata) {
                continue;
            }

            const match: RankedMatch = { depth, metadata };
            if (!best || isBetterMatch(match, best)) {
                best = match;
            }
        }

        if (best) {
            selections.push({ modelRowId: target.id, metadata: best.metadata });
        }
    }

    return selections;
}

/** `llm_metadata.limit` 是 JSON 字符串，缺字段或非数字都视为未声明。 */
function parseModelLimit(limit: string | null): {
    contextLimit: number | null;
    outputLimit: number | null;
} {
    if (!limit) {
        return { contextLimit: null, outputLimit: null };
    }

    const parsed: unknown = JSON.parse(limit);
    if (typeof parsed !== 'object' || parsed === null) {
        return { contextLimit: null, outputLimit: null };
    }

    const record = parsed as Record<string, unknown>;
    const context = record.context;
    const output = record.output;

    return {
        contextLimit: typeof context === 'number' ? context : null,
        outputLimit: typeof output === 'number' ? output : null,
    };
}

export function toMetadataRecord(row: {
    modelId: string;
    attachment: number;
    modalities: string;
    openWeights: number;
    reasoning: number;
    reasoningOptions: string | null;
    releaseDate: string | null;
    temperature: number;
    toolCall: number;
    knowledge: string | null;
    limit: string | null;
}): LlmMetadataRecord {
    const { contextLimit, outputLimit } = parseModelLimit(row.limit);

    return {
        modelId: row.modelId,
        attachment: row.attachment,
        modalities: row.modalities,
        openWeights: row.openWeights,
        reasoning: row.reasoning,
        reasoningOptions: row.reasoningOptions,
        releaseDate: row.releaseDate,
        temperature: row.temperature,
        toolCall: row.toolCall,
        knowledge: row.knowledge,
        contextLimit,
        outputLimit,
    };
}

/** 列里存的是 JSON 字符串；损坏或非对象都当作没有上游声明。 */
function parseUpstreamMetadata(value: string | null): UpstreamModelMetadataPatch | null {
    if (!value) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as UpstreamModelMetadataPatch)
            : null;
    } catch {
        return null;
    }
}

/**
 * 上游声明 > models.dev 兜底 > 行内已有值：`null` 交给 SQL 的 COALESCE 保留旧值。
 * 上游显式声明不支持思考时，连同旧档位一起清空。
 */
export function resolveModelMetadataRow(
    target: ModelMetadataTargetRow,
    metadata: LlmMetadataRecord | undefined
): ModelMetadataUpdateRow | null {
    const upstream = parseUpstreamMetadata(target.upstreamMetadata);
    if (!upstream && !metadata) {
        return null;
    }

    const clearReasoningOptions = upstream?.reasoning === 0 ? 1 : 0;

    return {
        id: target.id,
        attachment: upstream?.attachment ?? metadata?.attachment ?? null,
        modalities: upstream?.modalities ?? metadata?.modalities ?? null,
        open_weights: metadata?.openWeights ?? null,
        reasoning: upstream?.reasoning ?? metadata?.reasoning ?? null,
        reasoning_options: clearReasoningOptions
            ? null
            : (upstream?.reasoning_options ?? metadata?.reasoningOptions ?? null),
        release_date: metadata?.releaseDate ?? null,
        temperature: metadata?.temperature ?? null,
        tool_call: upstream?.tool_call ?? metadata?.toolCall ?? null,
        knowledge: metadata?.knowledge ?? null,
        context_limit: upstream?.context_limit ?? metadata?.contextLimit ?? null,
        output_limit: upstream?.output_limit ?? metadata?.outputLimit ?? null,
        clear_reasoning_options: clearReasoningOptions,
    };
}
