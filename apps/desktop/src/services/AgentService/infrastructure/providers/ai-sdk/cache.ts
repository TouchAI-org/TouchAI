// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';
import type { ModelMessage, ToolSet } from 'ai';

import type { AiRequestOptions, JsonObject } from '../../../contracts/protocol';

/** JSON schemas are JSON values; keep array order, canonicalize object keys only. */
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

export function canonicalSchema<T>(schema: T): T {
    return JSON.parse(canonicalJson(schema)) as T;
}

export function prepareCacheOptions(options: {
    driver: ProviderDriver;
    request: AiRequestOptions;
    messages: ModelMessage[];
    tools: ToolSet | undefined;
    providerOptions: Record<string, JsonObject> | undefined;
}) {
    const { driver, request, tools } = options;
    let messages = options.messages;
    const providerOptions = { ...options.providerOptions };
    if (driver === 'openai' && request.promptCacheKey) {
        providerOptions.openai = {
            ...providerOptions.openai,
            promptCacheKey: request.promptCacheKey,
        };
    }
    if (driver === 'anthropic' || driver === 'anthropic-compatible') {
        const hint = { cacheControl: { type: 'ephemeral' as const } };
        const toolNames = Object.keys(tools ?? {});
        const lastToolName = toolNames[toolNames.length - 1];
        const lastTool = lastToolName ? tools?.[lastToolName] : undefined;
        if (lastTool)
            lastTool.providerOptions = {
                ...lastTool.providerOptions,
                anthropic: { ...lastTool.providerOptions?.anthropic, ...hint },
            };
        // Four breakpoints at most: tools, system, and two recent user/tool boundaries.
        // Never put a marker on a signed reasoning block.
        const indexes = new Set<number>();
        let systemIndex = -1;
        messages.forEach((message, index) => {
            if (message.role === 'system') systemIndex = index;
        });
        if (systemIndex >= 0) indexes.add(systemIndex);
        for (let index = messages.length - 1, tails = 0; index >= 0 && tails < 2; index--) {
            if (messages[index]!.role !== 'user' && messages[index]!.role !== 'tool') continue;
            indexes.add(index);
            tails++;
        }
        messages = messages.map((message, index) =>
            indexes.has(index)
                ? {
                      ...message,
                      providerOptions: {
                          ...message.providerOptions,
                          anthropic: { ...message.providerOptions?.anthropic, ...hint },
                      },
                  }
                : message
        );
    }

    let maxOutputTokens = request.maxOutputTokens;
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
    return { messages, tools, providerOptions, maxOutputTokens };
}
