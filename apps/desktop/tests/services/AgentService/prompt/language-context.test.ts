import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
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
});
