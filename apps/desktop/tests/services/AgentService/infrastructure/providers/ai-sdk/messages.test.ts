import type { ToolSet } from 'ai';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';
import {
    buildModelMessages,
    buildToolSet,
} from '@/services/AgentService/infrastructure/providers/ai-sdk/messages';
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

describe('AI SDK tool result messages', () => {
    it('maps placeholder tool results into model-facing tool-result parts', async () => {
        const placeholderResult = 'Tool result is missing for historical tool call call_missing.';

        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'call_missing',
                            name: 'builtin__ask_user',
                            arguments: '{}',
                        },
                    ],
                },
                {
                    role: 'tool',
                    content: placeholderResult,
                    tool_call_id: 'call_missing',
                    name: 'builtin__ask_user',
                },
            ],
        });

        expect(messages).toHaveLength(2);
        expect(messages[1]).toEqual({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'call_missing',
                    toolName: 'builtin__ask_user',
                    output: {
                        type: 'text',
                        value: placeholderResult,
                    },
                },
            ],
        });
    });

    it('keeps sibling tool results together before hoisted tool-result attachments', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'call_screenshot',
                            name: 'builtin__browser',
                            arguments: '{"operation":"screenshot"}',
                        },
                        {
                            id: 'call_dom',
                            name: 'builtin__browser',
                            arguments: '{"operation":"dom"}',
                        },
                    ],
                },
                {
                    role: 'tool',
                    content: [
                        {
                            type: 'text',
                            text: 'screenshot captured',
                        },
                        {
                            type: 'image',
                            data: 'iVBORw0KGgo=',
                            mimeType: 'image/png',
                            kind: 'image',
                            name: 'screenshot.png',
                            sourcePath: 'C:\\Temp\\screenshot.png',
                            size: null,
                            semanticIntent: 'visual-reference',
                            meta: {
                                alias: 'A1',
                                order: 0,
                                type: 'image',
                                name: 'screenshot.png',
                                mimeType: 'image/png',
                                originPath: 'C:\\Temp\\screenshot.png',
                                attachmentId: null,
                                hash: null,
                            },
                        },
                    ],
                    tool_call_id: 'call_screenshot',
                    name: 'builtin__browser',
                },
                {
                    role: 'tool',
                    content: 'dom refs',
                    tool_call_id: 'call_dom',
                    name: 'builtin__browser',
                },
            ],
        });

        expect(messages.map((message) => message.role)).toEqual([
            'assistant',
            'tool',
            'tool',
            'user',
        ]);
        expect(messages[1]).toMatchObject({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'call_screenshot',
                },
            ],
        });
        expect(messages[2]).toMatchObject({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'call_dom',
                },
            ],
        });
        expect(messages[3]).toMatchObject({
            role: 'user',
        });
    });
});
