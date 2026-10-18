// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    estimateTokensFromChars,
    parsePromptBreakdown,
    sumFragmentChars,
} from '@utils/promptBreakdown';
import { and, between, desc, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';

import { db } from '../index';
import { models, sessionTurns } from '../schema';
import type { UsageFilter } from './usageStats';

// ============================================================================
// 类型
// ============================================================================

/** 上下文构成的一个分段（token 估算值） */
export interface ContextShare {
    key: string;
    tokens: number;
    share: number;
}

export interface ContextScorePart {
    key: 'cache' | 'lean' | 'pace' | 'reliable';
    points: number;
    most: number;
}

export interface ContextTag {
    key: string;
    tone: 'good' | 'warn' | 'info';
}

export interface ContextProfile {
    /** null 表示总体（跨模型） */
    modelId: number | null;
    modelName: string;
    window: number;
    turnCount: number;
    /** 单轮 prompt token 的中位数 / P90（精确值，来自供应商返回） */
    promptMedian: number;
    promptP90: number;
    /** 固定开销中位数：系统提示 + 工具定义 */
    baselineMedian: number;
    /** 相邻轮次增量中位数 */
    growthMedian: number;
    /** 峰值填充率 = max(prompt) / window */
    peakFill: number;
    /** 缓存复用率 = cacheRead / (cacheRead + input) */
    cacheReuseRate: number;
    compactCount: number;
    errorRate: number;
    /** 上下文构成的估算 token 分布 */
    shares: ContextShare[];
    /** 0-100 */
    score: number;
    scores: ContextScorePart[];
    tags: ContextTag[];
}

/** 单轮上下文采样点，用于曲线 */
export interface ContextTurnPoint {
    turnId: number;
    createdAt: string;
    modelId: number;
    promptTokens: number;
    window: number;
    fillRate: number;
    cacheReadTokens: number;
    /** 相对上一轮是同模型下 prompt 骤降，疑似压缩 */
    isCompaction: boolean;
}

// ============================================================================
// 常量
// ============================================================================

/** 压缩判定阈值：上一轮 ≥ 20k 且本轮不到其 60% */
const COMPACTION_MIN_TOKENS = 20_000;
const COMPACTION_RATIO = 0.6;

/**
 * 采样上限。
 *
 * 中位数与 P90 需要逐轮取值，无法在 SQL 里精确表达（SQLite 无 percentile 函数）。
 * 取最近 N 轮做统计：超出后老数据的边际价值很低，而内存与延迟可控。
 */
const SAMPLE_LIMIT = 5000;

/** 分段展示顺序 */
const SHARE_ORDER = [
    'systemPrompt',
    'builtinToolDefinitions',
    'mcpToolDefinitions',
    'conversation',
    'userPrompt',
    'attachments',
] as const;

// ============================================================================
// 工具函数
// ============================================================================

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function percentile(sorted: readonly number[], ratio: number): number {
    if (sorted.length === 0) {
        return 0;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
    return sorted[index] ?? 0;
}

function median(sorted: readonly number[]): number {
    if (sorted.length === 0) {
        return 0;
    }
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? 0;
    }
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * 上下文使用评分（0-100）。
 *
 * 权重沿用 magpie 的取值（cache 35 / lean 25 / pace 20 / reliable 20），
 * 这套权重在大量真实数据上验证过，改权重会让分数失去可比性。
 */
function scoreContext(input: {
    cacheReuseRate: number;
    cacheKnown: boolean;
    baselineMedian: number;
    window: number;
    growthMedian: number;
    errorRate: number;
}): { score: number; scores: ContextScorePart[] } {
    const window = Math.max(input.window, 1);

    // 缓存：命中率 90% 满分；供应商不报缓存时给中位分而不是 0
    const cache = input.cacheKnown ? clamp01(input.cacheReuseRate / 0.9) : 0.5;
    // 精简：固定开销 ≤5% 窗口满分，≥30% 零分
    const lean = clamp01(1 - (input.baselineMedian / window - 0.05) / 0.25);
    // 节奏：单轮增量 ≤1% 窗口满分，≥6% 零分
    const pace = clamp01(1 - (input.growthMedian / window - 0.01) / 0.05);
    // 可靠：失败率 20% 零分
    const reliable = clamp01(1 - input.errorRate / 0.2);

    const scores: ContextScorePart[] = [
        { key: 'cache', points: Math.round(cache * 35), most: 35 },
        { key: 'lean', points: Math.round(lean * 25), most: 25 },
        { key: 'pace', points: Math.round(pace * 20), most: 20 },
        { key: 'reliable', points: Math.round(reliable * 20), most: 20 },
    ];

    return { score: scores.reduce((sum, part) => sum + part.points, 0), scores };
}

function buildTags(input: {
    cacheReuseRate: number;
    cacheKnown: boolean;
    baselineMedian: number;
    mcpToolTokens: number;
    window: number;
    growthMedian: number;
    peakFill: number;
    compactCount: number;
    turnCount: number;
    errorRate: number;
    attachmentShare: number;
    userPromptShare: number;
}): ContextTag[] {
    const tags: ContextTag[] = [];
    const window = Math.max(input.window, 1);

    if (input.cacheKnown && input.cacheReuseRate >= 0.8) {
        tags.push({ key: 'cacheFriendly', tone: 'good' });
    }
    if (input.cacheKnown && input.cacheReuseRate < 0.4 && input.turnCount >= 5) {
        tags.push({ key: 'cacheMisses', tone: 'warn' });
    }
    if (input.baselineMedian / window <= 0.06) {
        tags.push({ key: 'lean', tone: 'good' });
    }
    if (input.baselineMedian / window >= 0.2) {
        tags.push({ key: 'heavyStart', tone: 'warn' });
    }
    if (input.mcpToolTokens >= 5000 && input.mcpToolTokens >= input.baselineMedian * 0.3) {
        tags.push({ key: 'mcpHeavy', tone: 'info' });
    }
    if (input.growthMedian / window >= 0.03) {
        tags.push({ key: 'fillsFast', tone: 'warn' });
    }
    if (input.peakFill >= 0.85) {
        tags.push({ key: 'nearFull', tone: 'warn' });
    }
    if (input.compactCount > 0) {
        tags.push({ key: 'compacts', tone: 'info' });
    }
    if (input.attachmentShare >= 0.15) {
        tags.push({ key: 'attachmentHeavy', tone: 'info' });
    }
    if (input.userPromptShare >= 0.3) {
        tags.push({ key: 'promptBloat', tone: 'info' });
    }
    if (input.turnCount >= 20 && input.errorRate < 0.01) {
        tags.push({ key: 'steady', tone: 'good' });
    }
    if (input.turnCount >= 5 && input.errorRate >= 0.1) {
        tags.push({ key: 'flaky', tone: 'warn' });
    }

    return tags;
}

// ============================================================================
// 采样
// ============================================================================

interface RawTurnSample {
    turnId: number;
    createdAt: string;
    modelId: number;
    modelName: string;
    window: number;
    promptTokens: number;
    cacheReadTokens: number;
    inputTokens: number;
    breakdown: string | null;
    failed: boolean;
}

function buildSampleWhere(filter: UsageFilter): SQL {
    const clauses: Array<SQL | undefined> = [
        between(sessionTurns.created_at, filter.from, filter.to),
        isNotNull(sessionTurns.prompt_breakdown_json),
    ];

    if (filter.modelIds?.length) {
        clauses.push(inArray(sessionTurns.model_id, filter.modelIds));
    }
    if (filter.providerIds?.length) {
        const providerIds = filter.providerIds;
        clauses.push(
            sql`${sessionTurns.model_id} IN (SELECT ${models.id} FROM ${models} WHERE ${models.provider_id} IN (${sql.join(
                providerIds.map((id) => sql`${id}`),
                sql`, `
            )}))`
        );
    }

    return and(...clauses)!;
}

/**
 * 取一段时间的逐轮上下文采样。
 *
 * `promptTokens` 用供应商返回的真实值（input + cacheRead + cacheWrite），
 * 不是估算值 —— 这是整个上下文页里唯一精确的量。
 */
async function loadSamples(filter: UsageFilter): Promise<RawTurnSample[]> {
    const rows = await db
        .select({
            turnId: sessionTurns.id,
            createdAt: sessionTurns.created_at,
            modelId: sessionTurns.model_id,
            modelName: models.name,
            window: sql<number>`coalesce(${models.context_limit}, 0)`,
            promptTokens: sql<number>`(
                ${sessionTurns.input_tokens}
                + ${sessionTurns.cache_read_tokens}
                + ${sessionTurns.cache_write_tokens}
            )`,
            cacheReadTokens: sessionTurns.cache_read_tokens,
            inputTokens: sessionTurns.input_tokens,
            breakdown: sessionTurns.prompt_breakdown_json,
            failed: sql<number>`case when ${sessionTurns.status} = 'failed' then 1 else 0 end`,
        })
        .from(sessionTurns)
        .innerJoin(models, eq(models.id, sessionTurns.model_id))
        .where(buildSampleWhere(filter))
        .orderBy(desc(sessionTurns.created_at), desc(sessionTurns.id))
        .limit(SAMPLE_LIMIT)
        .all();

    return rows.map((row) => ({
        turnId: row.turnId,
        createdAt: row.createdAt,
        modelId: row.modelId,
        modelName: row.modelName,
        window: row.window,
        promptTokens: row.promptTokens,
        cacheReadTokens: row.cacheReadTokens,
        inputTokens: row.inputTokens,
        breakdown: row.breakdown,
        failed: row.failed === 1,
    }));
}

/** 聚合一批采样的上下文画像 */
function profileFromSamples(
    samples: readonly RawTurnSample[],
    identity: { modelId: number | null; modelName: string }
): ContextProfile | null {
    if (samples.length === 0) {
        return null;
    }

    const prompts = samples.map((sample) => sample.promptTokens).sort((a, b) => a - b);
    const promptMedian = median(prompts);
    const promptP90 = percentile(prompts, 0.9);
    const peak = prompts[prompts.length - 1] ?? 0;

    const windows = samples.map((sample) => sample.window).filter((value) => value > 0);
    const window = windows.length > 0 ? Math.max(...windows) : 0;

    // 固定开销：系统提示 + 工具定义（按段落字符折算 token）
    const baselines: number[] = [];
    const shareTotals = new Map<string, number>();
    let userPromptChars = 0;
    let totalChars = 0;

    for (const sample of samples) {
        const parsed = parsePromptBreakdown(sample.breakdown);
        if (!parsed) {
            continue;
        }

        const systemTokens = estimateTokensFromChars(
            parsed.systemPromptTotal + parsed.builtinToolDefinitions + parsed.mcpToolDefinitions
        );
        baselines.push(systemTokens);

        const conversationChars = Math.max(
            0,
            parsed.systemPromptTotal - sumFragmentChars(parsed.fragments)
        );
        const segments: Record<string, number> = {
            systemPrompt: sumFragmentChars(parsed.fragments),
            builtinToolDefinitions: parsed.builtinToolDefinitions,
            mcpToolDefinitions: parsed.mcpToolDefinitions,
            conversation: conversationChars,
            userPrompt: parsed.userPrompt,
            attachments: parsed.attachments,
        };

        let sampleTotal = 0;
        for (const [key, chars] of Object.entries(segments)) {
            shareTotals.set(key, (shareTotals.get(key) ?? 0) + chars);
            sampleTotal += chars;
        }
        totalChars += sampleTotal;
        userPromptChars += parsed.userPrompt;
    }

    const baselineMedian =
        baselines.length > 0
            ? percentile(
                  baselines.sort((a, b) => a - b),
                  0.5
              )
            : 0;

    // 增量：按时间正序遍历，取相邻同模型轮次的差
    const chronological = [...samples].sort((a, b) => a.turnId - b.turnId);
    const growth: number[] = [];
    let compactionCount = 0;
    for (let index = 1; index < chronological.length; index += 1) {
        const previous = chronological[index - 1]!;
        const current = chronological[index]!;
        if (previous.modelId !== current.modelId) {
            continue;
        }
        const delta = current.promptTokens - previous.promptTokens;
        if (delta > 0) {
            growth.push(delta);
        }
        if (
            previous.promptTokens >= COMPACTION_MIN_TOKENS &&
            current.promptTokens < previous.promptTokens * COMPACTION_RATIO
        ) {
            compactionCount += 1;
        }
    }
    const growthMedian =
        growth.length > 0
            ? percentile(
                  growth.sort((a, b) => a - b),
                  0.5
              )
            : 0;

    const cacheReadTotal = samples.reduce((sum, sample) => sum + sample.cacheReadTokens, 0);
    const inputTotal = samples.reduce((sum, sample) => sum + sample.inputTokens, 0);
    const cacheKnown = cacheReadTotal > 0;
    const cacheReuseRate =
        cacheReadTotal + inputTotal > 0 ? cacheReadTotal / (cacheReadTotal + inputTotal) : 0;

    const failures = samples.filter((sample) => sample.failed).length;
    const errorRate = samples.length > 0 ? failures / samples.length : 0;

    const shares: ContextShare[] = SHARE_ORDER.map((key) => {
        const chars = shareTotals.get(key) ?? 0;
        return {
            key,
            tokens: estimateTokensFromChars(chars),
            share: totalChars > 0 ? chars / totalChars : 0,
        };
    });

    const { score, scores } = scoreContext({
        cacheReuseRate,
        cacheKnown,
        baselineMedian,
        window,
        growthMedian,
        errorRate,
    });

    const tags = buildTags({
        cacheReuseRate,
        cacheKnown,
        baselineMedian,
        mcpToolTokens: shareTotals.get('mcpToolDefinitions') ?? 0,
        window,
        growthMedian,
        peakFill: window > 0 ? peak / window : 0,
        compactCount: compactionCount,
        turnCount: samples.length,
        errorRate,
        attachmentShare: totalChars > 0 ? (shareTotals.get('attachments') ?? 0) / totalChars : 0,
        userPromptShare: totalChars > 0 ? userPromptChars / totalChars : 0,
    });

    return {
        modelId: identity.modelId,
        modelName: identity.modelName,
        window,
        turnCount: samples.length,
        promptMedian,
        promptP90,
        baselineMedian,
        growthMedian,
        peakFill: window > 0 ? peak / window : 0,
        cacheReuseRate,
        compactCount: compactionCount,
        errorRate,
        shares,
        score,
        scores,
        tags,
    };
}

// ============================================================================
// 对外查询
// ============================================================================

/**
 * 上下文画像：总体 + 每个模型一份。
 *
 * 总体是在全部采样上直接算的，不是各模型平均值的平均
 * （后者会遇到 `avg(avg)` 陷阱：小样本模型的比率会被放大）。
 */
export async function getContextProfiles(filter: UsageFilter): Promise<{
    overall: ContextProfile | null;
    models: ContextProfile[];
}> {
    const samples = await loadSamples(filter);
    if (samples.length === 0) {
        return { overall: null, models: [] };
    }

    const overall = profileFromSamples(samples, { modelId: null, modelName: '' });

    const byModel = new Map<number, RawTurnSample[]>();
    for (const sample of samples) {
        const bucket = byModel.get(sample.modelId);
        if (bucket) {
            bucket.push(sample);
        } else {
            byModel.set(sample.modelId, [sample]);
        }
    }

    const models = [...byModel.entries()]
        .map(([modelId, modelSamples]) =>
            profileFromSamples(modelSamples, {
                modelId,
                modelName: modelSamples[0]?.modelName ?? '',
            })
        )
        .filter((profile): profile is ContextProfile => profile !== null)
        .sort((a, b) => b.turnCount - a.turnCount);

    return { overall, models };
}

/** 逐轮填充率曲线（单模型或全部），按时间正序 */
export async function getContextTurnPoints(
    filter: UsageFilter,
    limit = 200
): Promise<ContextTurnPoint[]> {
    const samples = await loadSamples(filter);
    if (samples.length === 0) {
        return [];
    }

    const chronological = [...samples].sort((a, b) => a.turnId - b.turnId);
    const points: ContextTurnPoint[] = [];

    for (let index = 0; index < chronological.length; index += 1) {
        const sample = chronological[index]!;
        const previous = index > 0 ? chronological[index - 1]! : null;
        const isCompaction =
            previous !== null &&
            previous.modelId === sample.modelId &&
            previous.promptTokens >= COMPACTION_MIN_TOKENS &&
            sample.promptTokens < previous.promptTokens * COMPACTION_RATIO;

        points.push({
            turnId: sample.turnId,
            createdAt: sample.createdAt,
            modelId: sample.modelId,
            promptTokens: sample.promptTokens,
            window: sample.window,
            fillRate: sample.window > 0 ? sample.promptTokens / sample.window : 0,
            cacheReadTokens: sample.cacheReadTokens,
            isCompaction,
        });
    }

    return points.slice(-limit);
}
