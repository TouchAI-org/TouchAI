import type { ToolSet } from 'ai';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';
import { buildToolSet } from '@/services/AgentService/infrastructure/providers/ai-sdk/messages';
import { composePromptSnapshot } from '@/services/AgentService/prompt';

function createTool(description = 'Run a command.'): AiToolDefinition {
    return {
        name: 'test_tool',
        description,
        input_schema: {
            type: 'object',
            properties: {},
        },
    };
}

function getToolDescription(toolSet: ToolSet | undefined, name: string): string {
    const toolDefinition = toolSet?.[name] as { description?: string } | undefined;
    return toolDefinition?.description ?? '';
}

describe('AI SDK tool language context', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('adds the current English app language to model-facing tool descriptions', () => {
        setLocale('en-US');
        const tool = createTool();

        const toolSet = buildToolSet([tool]);
        const description = getToolDescription(toolSet, 'test_tool');

        expect(description).toContain('Run a command.');
        expect(description).toContain('Current TouchAI UI language: English (en-US).');
        expect(description).toContain(
            'Use this language for user-facing tool arguments or generated content unless the user explicitly asks otherwise.'
        );
        expect(tool.description).toBe('Run a command.');
    });

    it('adds the current Simplified Chinese app language without translating tool descriptions', () => {
        const toolSet = buildToolSet([createTool()]);
        const description = getToolDescription(toolSet, 'test_tool');

        expect(description).toContain('Run a command.');
        expect(description).toContain('Current TouchAI UI language: Simplified Chinese (zh-CN).');
    });

    it('does not duplicate the current language context when a description already includes it', () => {
        const descriptionWithContext = [
            'Run a command.',
            'Current TouchAI UI language: Simplified Chinese (zh-CN). Use this language for user-facing tool arguments or generated content unless the user explicitly asks otherwise.',
        ].join('\n\n');

        const toolSet = buildToolSet([createTool(descriptionWithContext)]);
        const description = getToolDescription(toolSet, 'test_tool');

        expect(description.match(/Current TouchAI UI language/g)).toHaveLength(1);
    });

    it('replaces stale language context instead of appending a conflicting one', () => {
        const descriptionWithStaleContext = [
            'Run a command.',
            'Current TouchAI UI language: English (en-US). Use this language for user-facing tool arguments or generated content unless the user explicitly asks otherwise.',
        ].join('\n\n');

        const toolSet = buildToolSet([createTool(descriptionWithStaleContext)]);
        const description = getToolDescription(toolSet, 'test_tool');

        expect(description).toContain('Run a command.');
        expect(description).toContain('Current TouchAI UI language: Simplified Chinese (zh-CN).');
        expect(description).not.toContain('Current TouchAI UI language: English (en-US).');
        expect(description.match(/Current TouchAI UI language/g)).toHaveLength(1);
    });

    it('uses the turn-frozen prompt language even if the UI locale changes before tool conversion', async () => {
        const snapshot = await composePromptSnapshot({
            prompt: '总结一下。',
        });
        setLocale('en-US');

        const toolSet = buildToolSet([createTool()], snapshot.modelLanguageContext);
        const description = getToolDescription(toolSet, 'test_tool');

        expect(description).toContain('Current TouchAI UI language: Simplified Chinese (zh-CN).');
        expect(description).not.toContain('Current TouchAI UI language: English (en-US).');
    });
});
