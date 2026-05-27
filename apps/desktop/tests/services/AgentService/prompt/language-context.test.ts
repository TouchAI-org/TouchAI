import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import {
    appendCurrentLanguageToolDescriptionContext,
    buildCurrentLanguageSystemPrompt,
    buildCurrentLanguageToolDescriptionContext,
    getCurrentModelLanguageContext,
} from '@/services/AgentService/languageContext';
import { composePromptSnapshot } from '@/services/AgentService/prompt';

describe('prompt current language context', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('adds the current English app language to the system prompt', async () => {
        setLocale('en-US');

        const snapshot = await composePromptSnapshot({
            prompt: 'Summarize this.',
        });

        expect(snapshot.systemPrompt).toContain('Current TouchAI UI language: English (en-US).');
        expect(snapshot.systemPrompt).toContain(
            'Use this language for user-facing replies by default unless the user explicitly asks for another language.'
        );
    });

    it('adds the current Simplified Chinese app language to the system prompt', async () => {
        const snapshot = await composePromptSnapshot({
            prompt: '总结一下。',
        });

        expect(snapshot.systemPrompt).toContain(
            'Current TouchAI UI language: Simplified Chinese (zh-CN).'
        );
        expect(snapshot.modelLanguageContext).toEqual({
            locale: 'zh-CN',
            label: 'Simplified Chinese (zh-CN)',
        });
    });

    it('keeps language context even when platform fragments are overridden', async () => {
        const snapshot = await composePromptSnapshot({
            prompt: '总结一下。',
            platform: [],
        });

        expect(snapshot.systemPrompt).toContain(
            'Current TouchAI UI language: Simplified Chinese (zh-CN).'
        );
    });

    it('builds the current system and tool language context from the active locale', () => {
        setLocale('en-US');

        expect(getCurrentModelLanguageContext()).toEqual({
            locale: 'en-US',
            label: 'English (en-US)',
        });
        expect(buildCurrentLanguageSystemPrompt()).toContain(
            'Current TouchAI UI language: English (en-US).'
        );
        expect(buildCurrentLanguageToolDescriptionContext()).toContain(
            'Use this language for user-facing tool arguments or generated content unless the user explicitly asks otherwise.'
        );
    });

    it('deduplicates stale tool language context while preserving the base description', () => {
        const description = [
            'Run a command.',
            'Current TouchAI UI language: English (en-US). Use this language for user-facing tool arguments or generated content unless the user explicitly asks otherwise.',
        ].join('\n\n');

        const nextDescription = appendCurrentLanguageToolDescriptionContext(description, {
            locale: 'zh-CN',
            label: 'Simplified Chinese (zh-CN)',
        });

        expect(nextDescription).toContain('Run a command.');
        expect(nextDescription).toContain(
            'Current TouchAI UI language: Simplified Chinese (zh-CN).'
        );
        expect(nextDescription).not.toContain('Current TouchAI UI language: English (en-US).');
        expect(nextDescription.match(/Current TouchAI UI language/g)).toHaveLength(1);
    });
});
