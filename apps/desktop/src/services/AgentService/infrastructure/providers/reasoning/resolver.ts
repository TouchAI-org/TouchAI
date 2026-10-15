// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    clampReasoningLevel,
    DEFAULT_REASONING_LEVEL,
    MIN_RESPONSE_TOKENS,
    type ReasoningLevelMap,
    SELECTABLE_REASONING_LEVELS,
    type SelectableReasoningLevel,
} from '../../../contracts/reasoning';
import type { ReasoningResolution, ResolveReasoningInput } from './types';

function hasMapEntries(map: ReasoningLevelMap): boolean {
    return Object.keys(map).length > 0;
}

/**
 * budget 形态模型的思考预算：在原生 min/max 之间按档位线性插值。
 */
function budgetTokensFor(
    level: SelectableReasoningLevel,
    range: { min?: number; max?: number } | undefined
): number | undefined {
    if (!range) {
        return undefined;
    }
    if (level === 'off') {
        return 0;
    }

    const min = range.min ?? MIN_RESPONSE_TOKENS;
    const max = range.max ?? Math.max(min, 32768);
    const index = SELECTABLE_REASONING_LEVELS.indexOf(level);
    const ratio = index / (SELECTABLE_REASONING_LEVELS.length - 1);
    const tokens = Math.round(min + (max - min) * ratio);
    return Math.min(max, Math.max(min, tokens));
}

/**
 * 未传档位时使用 DEFAULT_REASONING_LEVEL；根据 `reasoningLevelMap` clamp 到模型
 * 支持的档位；没有 metadata 时按 mode 走 provider fallback。
 */
export function resolveReasoning(input: ResolveReasoningInput): ReasoningResolution {
    const requested = input.level ?? DEFAULT_REASONING_LEVEL;
    const base = {
        format: input.format,
        mode: input.mode,
        requested,
        map: input.map,
        hasTools: input.hasTools,
        modelId: input.modelId,
    } as const;

    if (input.mode === 'off') {
        return {
            ...base,
            level: 'off',
            mapped: undefined,
            budgetTokens: undefined,
            source: 'off',
        };
    }

    if (hasMapEntries(input.map)) {
        const level = clampReasoningLevel(input.map, requested);
        const mapped = input.map[level];
        return {
            ...base,
            level,
            mapped: typeof mapped === 'string' ? mapped : undefined,
            budgetTokens: budgetTokensFor(level, input.budgetRange),
            source: 'capability',
        };
    }

    if (input.mode === 'passthrough') {
        return {
            ...base,
            level: requested,
            mapped: requested === 'off' ? undefined : requested,
            budgetTokens: budgetTokensFor(requested, input.budgetRange),
            source: 'fallback',
        };
    }

    // auto 且没有可用 metadata：不发 reasoning 参数。
    return {
        ...base,
        level: 'off',
        mapped: undefined,
        budgetTokens: undefined,
        source: 'fallback',
    };
}
