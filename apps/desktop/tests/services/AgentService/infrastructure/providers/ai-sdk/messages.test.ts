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

describe('the app language is shown to the model', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user gets English app language in model-facing tool descriptions', () => {
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

    it('user gets Simplified Chinese app language in the tools without translated descriptions', () => {
        const toolSet = buildToolSet([createTool()]);
        const description = getToolDescription(toolSet, 'test_tool');

        expect(description).toContain('Run a command.');
        expect(description).toContain('Current TouchAI UI language: Simplified Chinese (zh-CN).');
    });

    it('user sees no duplicated language note when a description already carries it', () => {
        const descriptionWithContext = [
            'Run a command.',
            'Current TouchAI UI language: Simplified Chinese (zh-CN). Use this language for user-facing tool arguments or generated content unless the user explicitly asks otherwise.',
        ].join('\n\n');

        const toolSet = buildToolSet([createTool(descriptionWithContext)]);
        const description = getToolDescription(toolSet, 'test_tool');

        expect(description.match(/Current TouchAI UI language/g)).toHaveLength(1);
    });

    it('user sees a stale language note replaced instead of a conflicting second one', () => {
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

    it('user keeps the language frozen at turn start even after the UI locale changes', async () => {
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

describe('tool results are replayed to the model', () => {
    it('user sees placeholder tool results become model-facing tool-result parts', async () => {
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

    it('user sees sibling tool results kept together before hoisted attachments', async () => {
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

describe('earlier reasoning is replayed to the model', () => {
    it('user sees reasoning provider options preserved when replaying assistant content', async () => {
        const providerOptions = {
            openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' },
        };

        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-5.2',
            supportsReasoning: true,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'reasoning', text: 'Think', providerOptions },
                        { type: 'text', text: 'Answer' },
                    ],
                },
            ],
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
            role: 'assistant',
            content: [
                { type: 'reasoning', text: 'Think', providerOptions },
                { type: 'text', text: 'Answer' },
            ],
        });
    });

    it('user keeps reasoning parts even when metadata reports no reasoning support', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            supportsReasoning: false,
            messages: [
                {
                    role: 'assistant',
                    content: [
                        { type: 'reasoning', text: 'Think' },
                        { type: 'text', text: 'Answer' },
                    ],
                },
            ],
        });

        // 是否真正发送由 provider / AI SDK 决定，不再用 supportsReasoning 硬 gate。
        expect(messages[0]).toEqual({
            role: 'assistant',
            content: [
                { type: 'reasoning', text: 'Think' },
                { type: 'text', text: 'Answer' },
            ],
        });
    });
});
