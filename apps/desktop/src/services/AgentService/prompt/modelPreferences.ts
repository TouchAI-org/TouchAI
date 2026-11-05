// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    findModelRoleWithProvider,
    isModelRoutingEnabled,
    listModelPreferences,
} from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import type { ModelRole } from '@database/types';
import { log } from '@services/ObservabilityService';

import type { ModelPreferenceWithModel } from '@/database/types';

function escapeMarkdownCell(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function formatModelLabel(model: ModelWithProvider | null): string {
    if (!model) {
        return 'Not configured';
    }
    return [model.provider_name, model.name].filter(Boolean).join(' / ');
}

function formatPreferenceModelLabel(preference: ModelPreferenceWithModel): string {
    return (
        [preference.provider_name, preference.model_name].filter(Boolean).join(' / ') ||
        'Unavailable'
    );
}

function isUsablePreference(preference: ModelPreferenceWithModel): boolean {
    return Boolean(
        preference.name.trim() &&
        preference.description.trim() &&
        preference.model_id !== null &&
        preference.provider_enabled === 1
    );
}

function formatPreferenceRow(preference: ModelPreferenceWithModel): string {
    return `| ${escapeMarkdownCell(preference.name)} | ${escapeMarkdownCell(preference.description)} | ${escapeMarkdownCell(formatPreferenceModelLabel(preference))} |`;
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
    return result.status === 'fulfilled' ? result.value : fallback;
}

export async function buildModelPreferencesPrompt(): Promise<string[]> {
    if (!(await isModelRoutingEnabled())) {
        return [];
    }

    const [preferencesResult, entryResult, fastResult, generalResult] = await Promise.allSettled([
        listModelPreferences(),
        findModelRoleWithProvider('entry'),
        findModelRoleWithProvider('fast'),
        findModelRoleWithProvider('general'),
    ]);

    const failedQueries = [preferencesResult, entryResult, fastResult, generalResult].filter(
        (result) => result.status === 'rejected'
    );
    if (failedQueries.length > 0) {
        log.warn('[ModelPreferencesPrompt] Failed to load model routing preferences');
    }

    const preferences = settledValue(preferencesResult, []);
    const entryModel = settledValue(entryResult, null);
    const fastModel = settledValue(fastResult, null);
    const generalModel = settledValue(generalResult, null);
    const usablePreferences = preferences.filter(isUsablePreference);

    const roleRows: Array<[ModelRole, string, string, string]> = [
        [
            'entry',
            'Default model',
            'Every user request starts here by default. It decides whether to answer directly or switch models.',
            formatModelLabel(entryModel),
        ],
        [
            'fast',
            'Fast model',
            'Simple questions and lightweight utility work. Falls back to the default model when not configured.',
            formatModelLabel(fastModel ?? entryModel),
        ],
        [
            'general',
            'General model',
            'Complex tasks that do not clearly match a custom scenario. Falls back to the default model when not configured.',
            formatModelLabel(generalModel ?? entryModel),
        ],
    ];

    return [
        [
            '## Model routing preferences',
            '',
            'The current model is the default model. Every user request starts here by default, and you act as the router by calling `builtin__upgrade_model` when another configured model is a better fit.',
            '',
            '| Role | When to use | Model |',
            '|------|-------------|-------|',
            ...roleRows.map(
                ([role, label, description, model]) =>
                    `| ${escapeMarkdownCell(label)} (${role}) | ${escapeMarkdownCell(description)} | ${escapeMarkdownCell(model)} |`
            ),
            '',
            'Use `builtin__upgrade_model` with `{ "role": "fast" }` for simple questions or lightweight utility tasks.',
            'Use `builtin__upgrade_model` with `{ "role": "general" }` for complex tasks when no custom scenario clearly matches.',
            'Use `builtin__upgrade_model` with `{ "restore": true }` or `{ "role": "entry" }` to return to the default model.',
            '',
            'You can switch to a specialized model when the task clearly matches one of these user-configured scenarios.',
            'Use the scenario name exactly as written in the table: call `builtin__upgrade_model` with `{ "scenario": "<Scenario>" }`.',
            '',
            '| Scenario | Description | Model |',
            '|----------|-------------|-------|',
            ...(usablePreferences.length > 0
                ? usablePreferences.map(formatPreferenceRow)
                : ['| None configured | No custom scenario preferences are available. | - |']),
            '',
            'Routing rules: use a custom scenario model when the task clearly matches that scenario. Otherwise use the fast model for simple work, the general model for complex work, and the default model for routing or unclear/general setup.',
            'Do not switch models repeatedly for the same task unless the conversation meaningfully changes.',
        ].join('\n'),
    ];
}
