import type { ToolSet } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import type { AiContentPart, AiMessage } from '@/services/AgentService/contracts/protocol';
import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';
import type { ProviderAttachmentRequestContext } from '@/services/AgentService/infrastructure/providers/ai-sdk/attachments';
import {
    buildModelMessages,
    buildToolSet,
} from '@/services/AgentService/infrastructure/providers/ai-sdk/messages';
import { composePromptSnapshot } from '@/services/AgentService/prompt';

const {
    findAttachmentRemoteRefMock,
    touchAttachmentRemoteRefLastUsedMock,
    upsertAttachmentRemoteRefMock,
} = vi.hoisted(() => ({
    findAttachmentRemoteRefMock: vi.fn(),
    touchAttachmentRemoteRefLastUsedMock: vi.fn(),
    upsertAttachmentRemoteRefMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    findAttachmentRemoteRef: findAttachmentRemoteRefMock,
    touchAttachmentRemoteRefLastUsed: touchAttachmentRemoteRefLastUsedMock,
    upsertAttachmentRemoteRef: upsertAttachmentRemoteRefMock,
}));

type ImagePart = Extract<AiContentPart, { type: 'image' }>;
type FilePartInput = Extract<AiContentPart, { type: 'file' }>;

function promptMeta(overrides: Partial<ImagePart['meta']> = {}): ImagePart['meta'] {
    return {
        alias: 'A1',
        order: 0,
        type: 'image',
        name: 'chart.png',
        mimeType: 'image/png',
        originPath: 'C:\\Temp\\chart.png',
        attachmentId: 7,
        hash: 'hash-chart',
        ...overrides,
    };
}

function imagePart(overrides: Partial<ImagePart> = {}): ImagePart {
    return {
        type: 'image',
        name: 'chart.png',
        sourcePath: 'C:\\Temp\\chart.png',
        size: 12,
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
        kind: 'image',
        semanticIntent: 'visual-reference',
        meta: promptMeta(),
        ...overrides,
    };
}

function pdfPart(overrides: Partial<FilePartInput> = {}): FilePartInput {
    return {
        type: 'file',
        name: 'report.pdf',
        sourcePath: 'C:\\Temp\\report.pdf',
        size: 24,
        mimeType: 'application/pdf',
        kind: 'pdf',
        semanticIntent: 'document-content',
        base64Data: 'JVBERi0=',
        meta: promptMeta({
            type: 'file',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            originPath: 'C:\\Temp\\report.pdf',
        }),
        ...overrides,
    };
}

function textFilePart(overrides: Partial<FilePartInput> = {}): FilePartInput {
    return {
        type: 'file',
        name: 'notes.txt',
        sourcePath: 'C:\\Temp\\notes.txt',
        size: 11,
        mimeType: 'text/plain',
        kind: 'text',
        semanticIntent: 'textual-content',
        textContent: 'hello world',
        meta: promptMeta({
            type: 'file',
            name: 'notes.txt',
            mimeType: 'text/plain',
            originPath: 'C:\\Temp\\notes.txt',
        }),
        ...overrides,
    };
}

function attachmentContext(
    overrides: Partial<ProviderAttachmentRequestContext> = {}
): ProviderAttachmentRequestContext {
    return {
        driver: 'google',
        providerId: 5,
        modelId: 'gemini-2.5-pro',
        apiTargets: { sdkBaseUrl: 'https://generativelanguage.example.test/v1beta' },
        apiKey: 'secret',
        customHeaders: {},
        fetch: vi.fn(),
        ...overrides,
    } as ProviderAttachmentRequestContext;
}

function jsonResponse(payload: unknown, init: { status?: number } = {}): Response {
    return {
        ok: (init.status ?? 200) < 400,
        status: init.status ?? 200,
        statusText: init.status === 404 ? 'Not Found' : 'OK',
        json: async () => payload,
        headers: new Headers(),
    } as unknown as Response;
}

/** The resumable-upload start call answers with the session URL in a header. */
function uploadStartResponse(uploadUrl: string): Response {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
        headers: new Headers({ 'x-goog-upload-url': uploadUrl }),
    } as unknown as Response;
}

function userMessage(content: AiMessage['content']): AiMessage {
    return { role: 'user', content };
}

function toolMessage(
    content: AiMessage['content'],
    options: { toolCallId?: string; name?: string } = {}
): AiMessage {
    return {
        role: 'tool',
        content,
        tool_call_id: options.toolCallId ?? 'call-1',
        name: options.name ?? 'builtin__browser',
    };
}

function resetRemoteRefMocks(): void {
    findAttachmentRemoteRefMock.mockReset();
    touchAttachmentRemoteRefLastUsedMock.mockReset();
    upsertAttachmentRemoteRefMock.mockReset();
    findAttachmentRemoteRefMock.mockResolvedValue(undefined);
    touchAttachmentRemoteRefLastUsedMock.mockResolvedValue(undefined);
    upsertAttachmentRemoteRefMock.mockResolvedValue(undefined);
}

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

describe('user sends an attachment in the prompt', () => {
    beforeEach(() => {
        resetRemoteRefMocks();
    });

    it('user sees the image handed to the model as image data', async () => {
        const { messages, manifestRequest } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [userMessage([{ type: 'text', text: 'what is this?' }, imagePart()])],
        });

        expect(messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'what is this?' },
                    { type: 'image', image: 'iVBORw0KGgo=', mediaType: 'image/png' },
                ],
            },
        ]);
        expect(manifestRequest.entries).toEqual([
            expect.objectContaining({
                alias: 'A1',
                name: 'chart.png',
                resolvedRole: 'user',
                transportMode: 'inline-image',
                attachmentId: 7,
            }),
        ]);
    });

    it('user sees the PDF handed to the model as a document', async () => {
        const { messages, manifestRequest } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [userMessage([pdfPart()])],
        });

        expect(messages).toEqual([
            {
                role: 'user',
                content: [
                    {
                        type: 'file',
                        data: 'JVBERi0=',
                        filename: 'report.pdf',
                        mediaType: 'application/pdf',
                    },
                ],
            },
        ]);
        expect(manifestRequest.entries[0]).toMatchObject({ transportMode: 'inline-base64' });
    });

    it('user sees a text attachment sent as its text under an attachment header', async () => {
        const { messages, manifestRequest } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [userMessage([textFilePart()])],
        });

        expect(messages[0]).toEqual({
            role: 'user',
            content: [{ type: 'text', text: '[Attachment A1 content]\nhello world' }],
        });
        expect(manifestRequest.entries[0]).toMatchObject({ transportMode: 'inline-text' });
    });

    it('user sees a PDF sent as labelled base64 text when the model cannot read documents', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'deepseek',
            modelId: 'deepseek-chat',
            messages: [userMessage([pdfPart()])],
        });

        expect(messages[0]).toEqual({
            role: 'user',
            content: [{ type: 'text', text: '[Attachment A1 content | binary base64]\nJVBERi0=' }],
        });
    });

    it('user sees the PDF uploaded once and referenced by its provider id', async () => {
        const requestContext = attachmentContext({ driver: 'openai' });
        vi.mocked(requestContext.fetch).mockResolvedValue(
            jsonResponse({ id: 'file-abc' }) as unknown as Response
        );

        const { messages, manifestRequest } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            attachmentContext: requestContext,
            messages: [userMessage([pdfPart()])],
        });

        expect(messages[0]).toEqual({
            role: 'user',
            content: [
                {
                    type: 'file',
                    data: 'file-abc',
                    filename: 'report.pdf',
                    mediaType: 'application/pdf',
                },
            ],
        });
        expect(manifestRequest.entries[0]).toMatchObject({
            transportMode: 'provider-file-ref',
            remoteRefStrategy: 'openai-file-id',
        });
    });

    it('user still gets the PDF inline when the provider refuses the upload', async () => {
        const requestContext = attachmentContext({ driver: 'openai', providerId: 41 });
        vi.mocked(requestContext.fetch).mockResolvedValue(
            jsonResponse({}, { status: 404 }) as unknown as Response
        );

        const { messages, manifestRequest } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            attachmentContext: requestContext,
            messages: [userMessage([pdfPart()])],
        });

        expect(messages[0]).toEqual({
            role: 'user',
            content: [
                {
                    type: 'file',
                    data: 'JVBERi0=',
                    filename: 'report.pdf',
                    mediaType: 'application/pdf',
                },
            ],
        });
        expect(manifestRequest.entries[0]).toMatchObject({
            transportMode: 'inline-base64',
            remoteRefStrategy: null,
        });
    });

    it('user sees a content part the model cannot receive dropped from the prompt', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [
                userMessage([
                    { type: 'text', text: 'go' },
                    { type: 'tool_use', id: 'call-1', name: 'bash', input: {} },
                ]),
            ],
        });

        expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'go' }] });
    });
});

describe("user's earlier turn used a tool that returned media", () => {
    beforeEach(() => {
        resetRemoteRefMocks();
    });

    it('user sees the tool image kept in the tool result when the model accepts media there', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'google',
            modelId: 'gemini-2.5-pro',
            messages: [toolMessage([imagePart({ meta: promptMeta({ alias: 'A2' }) })])],
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: 'call-1',
                    toolName: 'builtin__browser',
                    output: {
                        type: 'content',
                        value: [
                            { type: 'text', text: expect.stringContaining('[Attachment A2]') },
                            {
                                type: 'image-data',
                                data: 'iVBORw0KGgo=',
                                mediaType: 'image/png',
                            },
                        ],
                    },
                },
            ],
        });
    });

    it('user sees the tool image moved to a following user message when the model rejects media there', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [toolMessage([imagePart()])],
        });

        expect(messages.map((message) => message.role)).toEqual(['tool', 'user']);
        expect(messages[0]).toMatchObject({
            content: [
                {
                    type: 'tool-result',
                    output: {
                        type: 'text',
                        value: '[Tool result media hoisted to following user message]',
                    },
                },
            ],
        });
        expect(messages[1]).toMatchObject({
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: '[Tool result attachments]\ntool: builtin__browser\ntool_call_id: call-1',
                },
                { type: 'text', text: expect.stringContaining('[Attachment A1]') },
                { type: 'image', image: 'iVBORw0KGgo=', mediaType: 'image/png' },
            ],
        });
    });

    it('user sees hoisted tool media placed after the tool results that followed it', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [
                toolMessage([imagePart()], { toolCallId: 'call_media' }),
                toolMessage('dom refs', { toolCallId: 'call_dom' }),
                userMessage('next question'),
            ],
        });

        expect(messages.map((message) => message.role)).toEqual(['tool', 'tool', 'user', 'user']);
        expect(messages[3]).toMatchObject({ role: 'user' });
    });

    it('user sees a tool PDF uploaded and referenced by url when the model stores files', async () => {
        const requestContext = attachmentContext();
        const fetchMock = vi.mocked(requestContext.fetch);
        fetchMock.mockResolvedValueOnce(uploadStartResponse('https://upload.example.test/1'));
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                file: {
                    name: 'files/abc',
                    uri: 'https://generativelanguage.example.test/v1beta/files/abc',
                    state: 'ACTIVE',
                    expirationTime: '2026-06-01T00:00:00.000Z',
                },
            }) as unknown as Response
        );

        const { messages, manifestRequest } = await buildModelMessages({
            providerDriver: 'google',
            modelId: 'gemini-2.5-pro',
            attachmentContext: requestContext,
            messages: [toolMessage([pdfPart()])],
        });

        expect(messages[0]).toMatchObject({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    output: {
                        type: 'content',
                        value: [
                            { type: 'text', text: expect.stringContaining('[Attachment A1]') },
                            {
                                type: 'file-url',
                                url: 'https://generativelanguage.example.test/v1beta/files/abc',
                            },
                        ],
                    },
                },
            ],
        });
        expect(manifestRequest.entries[0]).toMatchObject({
            resolvedRole: 'tool',
            transportMode: 'provider-file-ref',
            remoteRefStrategy: 'url',
        });
    });

    it('user sees an oversized tool image uploaded and referenced by url', async () => {
        const requestContext = attachmentContext();
        const fetchMock = vi.mocked(requestContext.fetch);
        fetchMock.mockResolvedValueOnce(uploadStartResponse('https://upload.example.test/2'));
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                file: {
                    name: 'files/big',
                    uri: 'https://generativelanguage.example.test/v1beta/files/big',
                    state: 'ACTIVE',
                },
            }) as unknown as Response
        );

        const { messages } = await buildModelMessages({
            providerDriver: 'google',
            modelId: 'gemini-2.5-pro',
            attachmentContext: requestContext,
            messages: [toolMessage([imagePart({ size: 4 * 1024 * 1024, mimeType: 'image/png' })])],
        });

        expect(messages[0]).toMatchObject({
            content: [
                {
                    type: 'tool-result',
                    output: {
                        type: 'content',
                        value: [
                            { type: 'text', text: expect.stringContaining('[Attachment A1]') },
                            {
                                type: 'image-url',
                                url: 'https://generativelanguage.example.test/v1beta/files/big',
                            },
                        ],
                    },
                },
            ],
        });
    });

    it('user sees a tool PDF reused from the provider upload in the hoisted user message', async () => {
        const requestContext = attachmentContext({ driver: 'openai', modelId: 'gpt-4.1' });
        vi.mocked(requestContext.fetch).mockResolvedValue(
            jsonResponse({ id: 'file-tool-pdf' }) as unknown as Response
        );

        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            attachmentContext: requestContext,
            messages: [toolMessage([pdfPart()])],
        });

        expect(messages.map((message) => message.role)).toEqual(['tool', 'user']);
        expect(messages[1]).toMatchObject({
            role: 'user',
            content: [
                { type: 'text', text: expect.stringContaining('[Tool result attachments]') },
                { type: 'text', text: expect.stringContaining('[Attachment A1]') },
                {
                    type: 'file',
                    data: 'file-tool-pdf',
                    filename: 'report.pdf',
                    mediaType: 'application/pdf',
                },
            ],
        });
    });

    it('user sees a tool PDF sent as document data when the model reads media but stores no files', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'anthropic',
            modelId: 'claude-sonnet-4',
            messages: [toolMessage([pdfPart()])],
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    output: {
                        type: 'content',
                        value: [
                            { type: 'text', text: expect.stringContaining('[Attachment A1]') },
                            {
                                type: 'file-data',
                                data: 'JVBERi0=',
                                filename: 'report.pdf',
                                mediaType: 'application/pdf',
                            },
                        ],
                    },
                },
            ],
        });
    });

    it('user sees a tool text attachment sent as its text when media in tool results is supported', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'anthropic',
            modelId: 'claude-sonnet-4',
            messages: [toolMessage([textFilePart()])],
        });

        expect(messages[0]).toMatchObject({
            content: [
                {
                    type: 'tool-result',
                    output: {
                        type: 'content',
                        value: [
                            { type: 'text', text: expect.stringContaining('[Attachment A1]') },
                            { type: 'text', text: '[Attachment A1 content]\nhello world' },
                        ],
                    },
                },
            ],
        });
    });

    it('user sees a tool PDF sent as text when its bytes were not kept', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'anthropic',
            modelId: 'claude-sonnet-4',
            messages: [
                toolMessage([pdfPart({ base64Data: undefined, textContent: 'extracted text' })]),
            ],
        });

        expect(messages[0]).toMatchObject({
            content: [
                {
                    type: 'tool-result',
                    output: {
                        type: 'content',
                        value: [
                            { type: 'text', text: expect.stringContaining('[Attachment A1]') },
                            { type: 'text', text: '[Attachment A1 content]\nextracted text' },
                        ],
                    },
                },
            ],
        });
    });

    it('user sees a text-only tool result passed through without an attachment anchor', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [toolMessage([{ type: 'text', text: 'file.txt' }])],
        });

        expect(messages[0]).toMatchObject({
            content: [
                {
                    type: 'tool-result',
                    output: { type: 'text', value: 'file.txt' },
                },
            ],
        });
    });

    it('user sees a tool result with nothing recorded kept empty', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [toolMessage([])],
        });

        expect(messages[0]).toMatchObject({
            content: [{ type: 'tool-result', output: { type: 'text', value: '' } }],
        });
    });

    it('user sees a content part a tool result cannot carry dropped from the result', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [
                toolMessage([
                    { type: 'reasoning', text: 'thinking' },
                    { type: 'text', text: 'done' },
                ]),
            ],
        });

        expect(messages[0]).toMatchObject({
            content: [{ type: 'tool-result', output: { type: 'text', value: 'done' } }],
        });
    });
});

describe("user's earlier turn is replayed to the model", () => {
    beforeEach(() => {
        resetRemoteRefMocks();
    });

    it('user sees the system prompt replayed as a system message', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [{ role: 'system', content: 'You are TouchAI.' }],
        });

        expect(messages).toEqual([{ role: 'system', content: 'You are TouchAI.' }]);
    });

    it('user sees a system message with non-text content replayed as empty', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [{ role: 'system', content: [{ type: 'text', text: 'ignored' }] }],
        });

        expect(messages).toEqual([{ role: 'system', content: '' }]);
    });

    it('user sees a plain-text prompt replayed unchanged', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [userMessage('hello')],
        });

        expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('user sees an earlier tool call replayed with its parsed arguments', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [
                {
                    role: 'assistant',
                    content: 'reading',
                    tool_calls: [
                        { id: 'call-1', name: 'builtin__read', arguments: '{"path":"a.txt"}' },
                    ],
                },
            ],
        });

        expect(messages[0]).toMatchObject({
            role: 'assistant',
            content: [
                { type: 'text', text: 'reading' },
                {
                    type: 'tool-call',
                    toolCallId: 'call-1',
                    toolName: 'builtin__read',
                    input: { path: 'a.txt' },
                },
            ],
        });
    });

    it('user sees a tool call with unreadable arguments replayed with empty input', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'call-1', name: 'builtin__read', arguments: 'not json' }],
                },
            ],
        });

        expect(messages[0]).toMatchObject({
            content: [{ type: 'tool-call', toolCallId: 'call-1', input: {} }],
        });
    });

    it('user sees a tool call with no name dropped from the replay', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'call-1', name: '   ', arguments: '{}' }],
                },
            ],
        });

        expect(messages).toEqual([{ role: 'assistant', content: '' }]);
    });

    it('user sees an assistant turn with nothing recorded replayed as empty', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [{ role: 'assistant', content: '' }],
        });

        expect(messages).toEqual([{ role: 'assistant', content: '' }]);
    });

    it('user sees a file the assistant mentioned replayed as attachment text', async () => {
        const { messages } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            messages: [{ role: 'assistant', content: [textFilePart()] }],
        });

        expect(messages).toEqual([
            {
                role: 'assistant',
                content: '[Attachment A1 content]\nhello world',
            },
        ]);
    });

    it('user sees the attachment request numbered when it is not the first one', async () => {
        const { manifestRequest } = await buildModelMessages({
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
            providerId: 9,
            attachmentRequestIndex: 3,
            messages: [userMessage([imagePart()])],
        });

        expect(manifestRequest).toMatchObject({
            requestIndex: 3,
            providerDriver: 'openai',
            providerId: 9,
            modelId: 'gpt-4.1',
        });
    });
});

describe('user offers tools to the model', () => {
    it('user gets no tool set when no tool is offered', () => {
        expect(buildToolSet([])).toBeUndefined();
        expect(buildToolSet(undefined)).toBeUndefined();
    });

    it('user is told which tool has an unusable schema', () => {
        const brokenTool = {
            name: 'broken_tool',
            description: 'Broken.',
            input_schema: { type: 42, properties: {} },
        } as unknown as AiToolDefinition;

        expect(() => buildToolSet([brokenTool])).toThrow('Invalid tool input schema: broken_tool');
    });
});
