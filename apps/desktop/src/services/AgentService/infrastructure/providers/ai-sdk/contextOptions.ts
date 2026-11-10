// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject } from '../../../contracts/protocol';

/** Compare checkpoint JSON by value while preserving array order. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const object = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(object)
                .sort()
                .map((key) => [key, object[key]])
        );
    });
}

/** Keep provider output, including thinking, within the context reservation. */
export function prepareContextOptions(options: {
    maxOutputTokens: number | undefined;
    providerOptions: Record<string, JsonObject> | undefined;
}) {
    const providerOptions = { ...options.providerOptions };
    let maxOutputTokens = options.maxOutputTokens;
    const thinking = providerOptions.anthropic?.thinking;
    if (
        maxOutputTokens !== undefined &&
        thinking &&
        typeof thinking === 'object' &&
        !Array.isArray(thinking) &&
        thinking.type === 'enabled'
    ) {
        // AI SDK adds budgetTokens to maxOutputTokens for legacy Anthropic thinking.
        // TouchAI's budget is inclusive, so keep their sum inside the reserved space.
        const budget = Math.min(
            typeof thinking.budgetTokens === 'number' ? thinking.budgetTokens : 1024,
            Math.floor(maxOutputTokens * 0.75)
        );
        providerOptions.anthropic = {
            ...providerOptions.anthropic,
            thinking: budget >= 1024 ? { ...thinking, budgetTokens: budget } : { type: 'disabled' },
        };
        if (budget >= 1024) maxOutputTokens -= budget;
    }
    return { providerOptions, maxOutputTokens };
}
