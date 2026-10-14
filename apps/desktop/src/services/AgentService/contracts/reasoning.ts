// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * TouchAI 统一思考档位。
 *
 * 请求层只传递这里定义的档位；具体供应商在各自 provider driver 中把它
 * 翻译成自己的 reasoning effort / thinking 参数。
 */
export const REASONING_LEVELS = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'max';

const reasoningLevelSet = new Set<string>(REASONING_LEVELS);

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
    return typeof value === 'string' && reasoningLevelSet.has(value);
}
