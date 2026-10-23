import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import {
    appendCurrentLanguageToolDescriptionContext,
    buildCurrentLanguageSystemPrompt,
    buildCurrentLanguageToolDescriptionContext,
    getCurrentModelLanguageContext,
} from '@/services/AgentService/languageContext';
import { composePromptSnapshot } from '@/services/AgentService/prompt';

describe('the app language reaches the assistant', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user gets English app language in the system prompt', async () => {
        setLocale('en-US');

        const snapshot = await composePromptSnapshot({
            prompt: 'Summarize this.',
        });

        expect(snapshot.systemPrompt).toContain('Current TouchAI UI language: English (en-US).');
        expect(snapshot.systemPrompt).toContain(
            'Use this language for user-facing replies by default unless the user explicitly asks for another language.'
        );
    });

    it('user gets Simplified Chinese app language in the system prompt', async () => {
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

    it('user keeps the language context when platform fragments are overridden', async () => {
        const snapshot = await composePromptSnapshot({
            prompt: '总结一下。',
            platform: [],
        });

        expect(snapshot.systemPrompt).toContain(
            'Current TouchAI UI language: Simplified Chinese (zh-CN).'
        );
    });

    it('user sees the system and tool language context built from the active locale', () => {
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

    it('user sees a stale tool language note removed while the base description stays', () => {
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
