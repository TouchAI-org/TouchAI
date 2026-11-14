import type { AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';

import {
    deriveReasoningLevelMap,
    type SelectableReasoningLevel,
} from '../../../contracts/reasoning';
import type { ProviderReasoningInput } from '../types';
import type { ReasoningEncodingHints } from './types';

const anthropicReasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] satisfies NonNullable<
    AnthropicLanguageModelOptions['effort']
>[];

// These model families support adaptive thinking in the installed Anthropic SDK.
function supportsAdaptiveThinking(model: string): boolean {
    return [
        'claude-opus-4-6',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-opus-5',
        'claude-sonnet-4-6',
        'claude-sonnet-5',
        'claude-fable-5',
        'claude-mythos-5',
        'claude-mythos-preview',
        'claude-haiku-5-5',
    ].some((name) => model.includes(name));
}

function requiresAdaptiveThinking(model: string): boolean {
    return [
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'claude-fable-5',
        'claude-mythos-5',
        'claude-mythos-preview',
    ].some((name) => model.includes(name));
}

function supportedEfforts(model: string): Set<string> | undefined {
    if (model.includes('claude-opus-4-5')) return new Set(['low', 'medium', 'high']);
    if (!supportsAdaptiveThinking(model)) return undefined;
    // The SDK enum is broader than the effort levels accepted by each model.
    const supportsXhigh = !['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-mythos-preview'].some(
        (name) => model.includes(name)
    );
    return new Set(
        anthropicReasoningEfforts.filter((effort) => supportsXhigh || effort !== 'xhigh')
    );
}

export function getAnthropicReasoningHints(
    options: ProviderReasoningInput
): ReasoningEncodingHints {
    const adaptive = supportsAdaptiveThinking(options.model);
    return {
        forceAdaptiveThinking: adaptive,
        supportsReasoningEffort: supportedEfforts(options.model) !== undefined,
    };
}

export function filterAnthropicReasoningLevels(
    levels: SelectableReasoningLevel[],
    options: ProviderReasoningInput
): SelectableReasoningLevel[] {
    const efforts = supportedEfforts(options.model);
    if (!efforts) return levels;
    const map = deriveReasoningLevelMap(options.reasoningOptions);
    return levels.filter((level) => {
        if (level === 'off') return !requiresAdaptiveThinking(options.model);
        return efforts.has(map[level] ?? level);
    });
}
