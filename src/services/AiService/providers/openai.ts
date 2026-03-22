// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { createTauriFetch } from '@services/AiService/providers/shared/tauri-fetch';
import OpenAI from 'openai';

import type {
    AiProvider,
    AiProviderConfig,
    AiRequestOptions,
    AiResponse,
    AiStreamChunk,
    AiToolDefinition,
    ModelInfo,
} from '../types';

function renderFilePart(name: string, content: string, isBinary: boolean): string {
    const header = `[文件: ${name}]`;
    return isBinary ? `${header}\n(二进制 Base64)\n${content}` : `${header}\n${content}`;
}

function mapOpenAiContent(
    content: AiRequestOptions['messages'][number]['content']
): OpenAI.Chat.ChatCompletionMessageParam['content'] {
    if (!Array.isArray(content)) {
        return content;
    }

    return content.map((part) => {
        if (part.type === 'text') {
            return { type: 'text', text: part.text };
        }
        if (part.type === 'image') {
            return {
                type: 'image_url',
                image_url: { url: `data:${part.mimeType};base64,${part.data}` },
            };
        }
        if (part.type === 'file') {
            return { type: 'text', text: renderFilePart(part.name, part.content, part.isBinary) };
        }
        // tool_use 和 tool_result 在 buildOpenAiMessages 中单独处理
        return { type: 'text', text: '' };
    });
}

function buildOpenAiMessages(
    messages: AiRequestOptions['messages']
): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((message) => {
        if (message.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: message.tool_call_id!,
                content: typeof message.content === 'string' ? message.content : '',
            } as OpenAI.Chat.ChatCompletionToolMessageParam;
        }

        const baseMessage = {
            role: message.role,
            content: mapOpenAiContent(message.content),
        };

        if (message.tool_calls) {
            return {
                role: message.role,
                content: message.content || null,
                tool_calls: message.tool_calls.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                        name: tc.name,
                        arguments: tc.arguments || '{}',
                    },
                })),
            } as OpenAI.Chat.ChatCompletionAssistantMessageParam;
        }

        return baseMessage as OpenAI.Chat.ChatCompletionMessageParam;
    });
}

function mapToolsToOpenAi(
    tools?: AiToolDefinition[]
): OpenAI.Chat.ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((tool) => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
        },
    }));
}

/**
 * OpenAI 协议适配器。
 *
 * 负责把内部统一的消息/工具结构映射到 Chat Completions 接口，
 * 并把流式 delta 再还原回应用自己的增量事件格式。
 */
export class OpenAiProvider implements AiProvider {
    name = 'OpenAI';
    type = 'openai' as const;
    private client: OpenAI;

    constructor(config: AiProviderConfig) {
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.apiEndpoint,
            dangerouslyAllowBrowser: true,
            fetch: createTauriFetch(),
        });
    }

    async request(options: AiRequestOptions): Promise<AiResponse> {
        const messages = buildOpenAiMessages(options.messages);
        const tools = mapToolsToOpenAi(options.tools);
        const completion = await this.client.chat.completions.create({
            model: options.model,
            messages,
            tools,
            stream: false,
        });

        const firstChoice = completion.choices[0];
        const content = firstChoice?.message?.content || '';

        return {
            content,
            tokensUsed: completion.usage?.total_tokens,
            finishReason: firstChoice?.finish_reason,
        };
    }

    async *stream(options: AiRequestOptions): AsyncGenerator<AiStreamChunk, void, unknown> {
        const messages = buildOpenAiMessages(options.messages);
        const tools = mapToolsToOpenAi(options.tools);
        const stream = await this.client.chat.completions.create(
            {
                model: options.model,
                messages,
                tools,
                stream: true,
            },
            { signal: options.signal }
        );

        // OpenAI 可能把同一个 tool call 的 id / name / arguments 拆成多次 delta，
        // 必须按 index 聚合，前端草稿和最终 tool_call 才能拿到完整参数。
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

        for await (const chunk of stream) {
            // 官方客户端没有给 reasoning_content 补类型，这里在本地做一次窄化适配。
            const delta = chunk.choices[0]?.delta as {
                reasoning_content?: string;
                tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: 'function';
                    function?: { name?: string; arguments?: string };
                }>;
            } & OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta;

            const content = delta?.content || '';
            const reasoning = delta?.reasoning_content || '';
            const finishReason = chunk.choices[0]?.finish_reason;
            const toolCallDeltas: AiStreamChunk['toolCallDeltas'] = [];

            // 累积工具调用增量
            if (delta?.tool_calls) {
                for (const toolCallDelta of delta.tool_calls) {
                    const index = toolCallDelta.index;
                    const existing = toolCallsMap.get(index) || {
                        id: '',
                        name: '',
                        arguments: '',
                    };

                    if (toolCallDelta.id) {
                        existing.id = toolCallDelta.id;
                    }
                    if (toolCallDelta.function?.name) {
                        existing.name += toolCallDelta.function.name;
                    }
                    if (toolCallDelta.function?.arguments) {
                        existing.arguments += toolCallDelta.function.arguments;
                    }

                    toolCallsMap.set(index, existing);
                    toolCallDeltas.push({
                        index,
                        callId: existing.id || undefined,
                        name: existing.name || undefined,
                        argumentsDelta: toolCallDelta.function?.arguments,
                        argumentsBuffer: existing.arguments,
                        isComplete: false,
                    });
                }
            }

            if (reasoning) {
                yield { content: '', reasoning, done: false };
            }

            if (content) {
                yield { content, done: false };
            }

            if (toolCallDeltas.length > 0) {
                yield {
                    content: '',
                    done: false,
                    toolCallDeltas,
                };
            }

            if (finishReason) {
                // OpenAI 有时在存在 tool calls 时也返回 finish_reason 'stop'，
                // 因此无论 finishReason 值如何都检查 toolCallsMap。
                // 但只保留 id 和 name 均非空的条目，过滤掉不完整的数据。
                const validToolCalls = Array.from(toolCallsMap.values()).filter(
                    (tc) => tc.id && tc.name
                );
                const toolCalls =
                    validToolCalls.length > 0
                        ? validToolCalls.map((tc) => ({
                              id: tc.id,
                              name: tc.name,
                              arguments: tc.arguments,
                          }))
                        : undefined;

                yield {
                    content: '',
                    done: true,
                    finishReason: toolCalls ? 'tool_calls' : finishReason,
                    toolCalls,
                };
                return;
            }
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            await this.client.models.list();
            return true;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<ModelInfo[]> {
        const response = await this.client.models.list();
        return response.data.map((model) => ({
            id: model.id,
            name: model.id,
        }));
    }
}
