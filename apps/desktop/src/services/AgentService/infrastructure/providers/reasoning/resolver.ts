// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    DEFAULT_REASONING_LEVEL,
    isReasoningLevel,
    REASONING_LEVELS,
    type ReasoningLevel,
    type ReasoningOption,
} from '../../../contracts/reasoning';
import type { ReasoningNative, ReasoningPlan, ResolveReasoningInput } from './types';

const reasoningLevelIndex = new Map<ReasoningLevel, number>(
    REASONING_LEVELS.map((level, index) => [level, index])
);

/**
 * 在受支持档位里挑选与请求档位最接近的一个。
 *
 * 平局时优先更高档（与 opencode 的 variant 选择一致）。
 */
export function clampToSupportedLevel(
    requested: ReasoningLevel,
    supported: readonly ReasoningLevel[]
): ReasoningLevel | undefined {
    const requestedIndex = reasoningLevelIndex.get(requested);
    if (requestedIndex === undefined || supported.length === 0) {
        return undefined;
    }

    let nearest: ReasoningLevel | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of supported) {
        const candidateIndex = reasoningLevelIndex.get(candidate);
        if (candidateIndex === undefined) {
            continue;
        }

        const distance = Math.abs(candidateIndex - requestedIndex);
        const nearestIndex = nearest ? (reasoningLevelIndex.get(nearest) ?? -1) : -1;
        if (
            distance < nearestDistance ||
            (distance === nearestDistance && candidateIndex > nearestIndex)
        ) {
            nearest = candidate;
            nearestDistance = distance;
        }
    }

    return nearest;
}

/** 只保留 TouchAI 统一档位，忽略上游自定义值。 */
function canonicalValues(values: readonly string[]): ReasoningLevel[] {
    return values.filter(isReasoningLevel);
}

function budgetTokensFor(
    requested: ReasoningLevel,
    option: Extract<ReasoningOption, { type: 'budget_tokens' }>
): number {
    const min = option.min ?? 1024;
    const max = option.max ?? Math.max(min, 32768);
    const requestedIndex = reasoningLevelIndex.get(requested) ?? 0;
    const ratio = requestedIndex / (REASONING_LEVELS.length - 1);
    const tokens = Math.round(min + (max - min) * ratio);
    return Math.min(max, Math.max(min, tokens));
}

/**
 * 根据 metadata capability 解析原生档位。
 *
 * 优先级：显式关闭 → effort → toggle → budget_tokens。
 * DeepSeek 这类同时声明 toggle + effort 的模型，none 走 toggle 关闭，
 * 其余档位走 effort。
 */
function resolveFromCapability(
    requested: ReasoningLevel,
    capability: ReasoningOption[]
): ReasoningNative | undefined {
    const effort = capability.find(
        (option): option is Extract<ReasoningOption, { type: 'effort' }> => option.type === 'effort'
    );
    const toggle = capability.find(
        (option): option is Extract<ReasoningOption, { type: 'toggle' }> => option.type === 'toggle'
    );
    const budget = capability.find(
        (option): option is Extract<ReasoningOption, { type: 'budget_tokens' }> =>
            option.type === 'budget_tokens'
    );

    if (requested === 'none' && toggle) {
        return { kind: 'toggle', enabled: false };
    }

    if (effort) {
        const clamped = clampToSupportedLevel(requested, canonicalValues(effort.values));
        if (clamped) {
            return { kind: 'effort', effort: clamped };
        }
    }

    if (toggle) {
        return { kind: 'toggle', enabled: requested !== 'none' };
    }

    if (budget) {
        return { kind: 'budget', tokens: budgetTokensFor(requested, budget) };
    }

    return undefined;
}

/**
 * 未传档位时使用 DEFAULT_REASONING_LEVEL；根据 capability 选择最接近的原生档位；
 * 没有 metadata 时按 mode 走 provider fallback。
 */
export function resolveReasoning(input: ResolveReasoningInput): ReasoningPlan {
    const requested = input.level ?? DEFAULT_REASONING_LEVEL;
    const base = {
        protocol: input.protocol,
        mode: input.mode,
        requested,
        hasTools: input.hasTools,
        modelId: input.modelId,
    } as const;

    if (input.mode === 'off') {
        return { ...base, native: { kind: 'none' }, source: 'off' };
    }

    if (input.capability.length > 0) {
        const native = resolveFromCapability(requested, input.capability);
        if (native) {
            return { ...base, native, source: 'capability' };
        }
    }

    if (input.mode === 'passthrough') {
        return { ...base, native: { kind: 'effort', effort: requested }, source: 'fallback' };
    }

    // auto 且没有可用 metadata：不发 reasoning 参数。
    return { ...base, native: { kind: 'none' }, source: 'fallback' };
}
