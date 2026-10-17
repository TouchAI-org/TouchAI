/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

/**
 * 中转站等上游会改写模型 id：加日期、加 `-latest`、加网关命名空间前缀
 * （`any/`、`group/auto-` 等）。这里按「裁得越少越可信」的原则，把运行时 id
 * 逐层裁掉可识别的命名空间前缀、网关前缀与版本/发布后缀，产出候选 id。
 *
 * 规则是纯函数、跑在应用层而不是 SQL 里：每层只裁一刀的语义用循环表达更直观，
 * 也便于直接单测；行为与旧递归 CTE 保持一致。
 */

export interface ModelIdCandidate {
    /** 裁剪后的候选 id。 */
    candidate: string;
    /** 裁剪层数；0 表示原始 id。 */
    depth: number;
}

/** 与旧 SQL 递归 CTE 的深度上限保持一致。 */
export const MAX_MODEL_ID_CANDIDATE_DEPTH = 6;

interface StripRule {
    matches: (candidate: string) => boolean;
    stripLength: number;
}

const DATE_SUFFIX_RULES: readonly StripRule[] = [
    { matches: (candidate) => /-\d{4}-\d{2}-\d{2}$/.test(candidate), stripLength: 11 },
    { matches: (candidate) => /-\d{8}$/.test(candidate), stripLength: 9 },
    { matches: (candidate) => /-\d{6}$/.test(candidate), stripLength: 7 },
    { matches: (candidate) => /-\d{4}$/.test(candidate), stripLength: 5 },
];

const NAMED_SUFFIX_RULES: readonly StripRule[] = [
    { matches: (candidate) => candidate.endsWith('-latest'), stripLength: 7 },
    { matches: (candidate) => candidate.endsWith('-preview'), stripLength: 8 },
    { matches: (candidate) => candidate.endsWith('-exp'), stripLength: 4 },
];

const SUFFIX_RULES: readonly StripRule[] = [...DATE_SUFFIX_RULES, ...NAMED_SUFFIX_RULES];

const ROUTE_PREFIXES: readonly { prefix: string; stripLength: number }[] = [
    { prefix: 'auto-', stripLength: 5 },
    { prefix: 'any-', stripLength: 4 },
];

/**
 * SQLite 的 lower() 只折叠 ASCII 字符；这里保持同样语义，
 * 避免同一份 id 在 SQL 与 JS 之间出现大小写处理差异。
 */
function asciiLower(value: string): string {
    return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** 每层最多裁一刀：后缀、命名空间前缀、路由前缀各自独立成枝。 */
function stripOneSuffix(candidate: string): string | undefined {
    for (const rule of SUFFIX_RULES) {
        if (rule.matches(candidate)) {
            return candidate.slice(0, -rule.stripLength);
        }
    }

    return undefined;
}

function nextCandidates(candidate: string): string[] {
    const next: string[] = [];

    const strippedSuffix = stripOneSuffix(candidate);
    if (strippedSuffix !== undefined) {
        next.push(strippedSuffix);
    }

    const namespaceIndex = candidate.indexOf('/');
    if (namespaceIndex > 0) {
        next.push(candidate.slice(namespaceIndex + 1));
    }

    for (const { prefix, stripLength } of ROUTE_PREFIXES) {
        // 与旧 GLOB（'auto-?*' / 'any-?*'）一致：前缀后必须还有字符。
        if (candidate.startsWith(prefix) && candidate.length > stripLength) {
            next.push(candidate.slice(stripLength));
        }
    }

    return next;
}

function compareCandidates(left: ModelIdCandidate, right: ModelIdCandidate): number {
    if (left.depth !== right.depth) {
        return left.depth - right.depth;
    }

    if (left.candidate === right.candidate) {
        return 0;
    }

    return left.candidate < right.candidate ? -1 : 1;
}

/**
 * 广度优先展开模型 id 的候选集合。
 *
 * 同一候选保留最小 depth（重复路径不影响最终选优），结果按 depth 升序稳定排序。
 */
export function expandModelIdCandidates(
    modelId: string,
    maxDepth: number = MAX_MODEL_ID_CANDIDATE_DEPTH
): ModelIdCandidate[] {
    const root = asciiLower(modelId);
    const bestDepth = new Map<string, number>([[root, 0]]);
    const queue: ModelIdCandidate[] = [{ candidate: root, depth: 0 }];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.depth >= maxDepth) {
            continue;
        }

        for (const candidate of nextCandidates(current.candidate)) {
            const depth = current.depth + 1;
            const knownDepth = bestDepth.get(candidate);
            if (knownDepth !== undefined && knownDepth <= depth) {
                continue;
            }

            bestDepth.set(candidate, depth);
            queue.push({ candidate, depth });
        }
    }

    return [...bestDepth.entries()]
        .map(([candidate, depth]) => ({ candidate, depth }))
        .sort(compareCandidates);
}
