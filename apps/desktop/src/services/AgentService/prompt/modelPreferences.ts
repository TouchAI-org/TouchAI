// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { findModelRoleWithProvider, listModelPreferences } from '@database/queries';
import type { ModelRole, ModelWithProvider } from '@database/queries/models';
import type { ModelPreferenceWithModel } from '@database/types';

function escapeMarkdownCell(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function formatModelLabel(preference: ModelPreferenceWithModel): string {
    const providerName = preference.provider_name?.trim();
    const modelName = preference.model_name?.trim();
    return [providerName, modelName].filter(Boolean).join(' / ') || 'Unavailable';
}

function formatRoleModelLabel(model: ModelWithProvider | null): string {
    if (!model) {
        return 'Not configured';
    }
    return [model.provider_name, model.name].filter(Boolean).join(' / ');
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
    return `| ${escapeMarkdownCell(preference.name)} | ${escapeMarkdownCell(preference.description)} | ${escapeMarkdownCell(formatModelLabel(preference))} |`;
}

export async function buildModelPreferencesPrompt(): Promise<string[]> {
    const [preferences, entryModel, fastModel, generalModel] = await Promise.all([
        listModelPreferences(),
        findModelRoleWithProvider('entry'),
        findModelRoleWithProvider('fast'),
        findModelRoleWithProvider('general'),
    ]).catch((error) => {
        console.warn('[ModelPreferencesPrompt] Failed to load model routing preferences:', error);
        return [[], null, null, null] as const;
    });
    const usablePreferences = preferences.filter(isUsablePreference);

    const roleRows: Array<[ModelRole, string, string, string]> = [
        [
            'entry',
            'Entry model',
            'Every user request starts here. It decides whether to answer directly or switch models.',
            formatRoleModelLabel(entryModel),
        ],
        [
            'fast',
            'Fast model',
            'Simple questions and lightweight utility work such as brief answers or session naming. Falls back to the entry model when not configured.',
            formatRoleModelLabel(fastModel ?? entryModel),
        ],
        [
            'general',
            'General model',
            'Complex tasks that do not clearly match a custom scenario preference. Falls back to the entry model when not configured.',
            formatRoleModelLabel(generalModel ?? entryModel),
        ],
    ];

    return [
        [
            '## Model routing preferences',
            '',
            'The current model is the entry model. Every user request starts here, and you act as the router by calling `builtin__upgrade_model` when another configured model is a better fit.',
            '',
            '| Role | When to use | Model |',
            '|------|-------------|-------|',
            ...roleRows.map(
                ([role, label, description, model]) =>
                    `| ${escapeMarkdownCell(label)} (${role}) | ${escapeMarkdownCell(description)} | ${escapeMarkdownCell(model)} |`
            ),
            '',
            'Use `builtin__upgrade_model` with `{ "role": "fast" }` for simple questions or lightweight utility tasks.',
            'Use `builtin__upgrade_model` with `{ "role": "general" }` for complex tasks when no custom scenario below clearly matches.',
            'Use `builtin__upgrade_model` with `{ "restore": true }` or `{ "role": "entry" }` to return to the entry model.',
            '',
            'You can switch to a specialized model when the task clearly matches one of these user-configured scenarios.',
            'Call `builtin__upgrade_model` with `{ "scenario": "<Scenario>" }` to switch to that scenario model.',
            '',
            '| Scenario | Description | Model |',
            '|----------|-------------|-------|',
            ...(usablePreferences.length > 0
                ? usablePreferences.map(formatPreferenceRow)
                : ['| None configured | No custom scenario preferences are available. | - |']),
            '',
            'Routing rules: use a custom scenario model when the task clearly matches that scenario. Otherwise use the fast model for simple work, the general model for complex work, and the entry model for routing or unclear/general setup.',
            'Do not switch models repeatedly for the same task unless the conversation meaningfully changes.',
        ].join('\n'),
    ];
}
