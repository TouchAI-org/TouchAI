// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Canonical reasoning-effort values shared across providers.
 *
 * Provider-specific request values are translated in the provider layer so
 * callers never need to know whether a backend expects `high`, `xhigh`,
 * `max`, or a provider-specific providerOptions key.
 */
export const REASONING_EFFORTS = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const reasoningEffortSet = new Set<string>(REASONING_EFFORTS);

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === 'string' && reasoningEffortSet.has(value);
}
