/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

/**
 * 中转站等上游会改写模型 id：加日期、加 `-latest`、加命名空间或路由前缀
 * （`any/`、`group/auto-` 等）。这里按「裁得越少越可信」逐层裁剪候选 id，
 * 供 `sync.ts` 与 models.dev 别名精确匹配。
 */

export interface ModelIdCandidate {
    candidate: string;
    /** 裁剪层数，0 为原始 id。 */
    depth: number;
}

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

/** 与别名表存储的形态一致：只折叠 ASCII 大小写。 */
function asciiLower(value: string): string {
    return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

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
        // 前缀后必须还有字符，否则裁剪结果为空。
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

/** 逐层展开候选 id：同一候选保留最小 depth，结果按 depth 升序排序。 */
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
