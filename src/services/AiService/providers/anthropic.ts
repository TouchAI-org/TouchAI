// Copyright (c) 2026. 千诚. Licensed under GPL v3

import Anthropic from '@anthropic-ai/sdk';
import { createTauriFetch } from '@services/AiService/providers/shared/tauri-fetch';

import type {
    AiProvider,
    AiProviderConfig,
    AiRequestOptions,
    AiResponse,
    AiStreamChunk,
    AiToolDefinition,
    ModelInfo,
} from '../types';

type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const anthropicImageTypes: AnthropicImageMediaType[] = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
];

function normalizeAnthropicMediaType(mimeType: string): AnthropicImageMediaType {
    if (anthropicImageTypes.includes(mimeType as AnthropicImageMediaType)) {
        return mimeType as AnthropicImageMediaType;
    }
    return 'image/png';
}

function renderFilePart(name: string, content: string, isBinary: boolean): string {
    const header = `[文件: ${name}]`;
    return isBinary ? `${header}\n(二进制 Base64)\n${content}` : `${header}\n${content}`;
}

function serializeToolInput(input: unknown): string | undefined {
    if (input === undefined) {
        return undefined;
    }

    if (typeof input === 'string') {
        return input.trim() ? input : undefined;
    }

    try {
        return JSON.stringify(input);
    } catch {
        return undefined;
    }
}

function mapAnthropicContent(
    content: AiRequestOptions['messages'][number]['content']
): Anthropic.MessageParam['content'] {
    if (!Array.isArray(content)) {
        return content;
    }

    return content.map((part) => {
        if (part.type === 'text') {
            return { type: 'text', text: part.text };
        }
        if (part.type === 'image') {
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: normalizeAnthropicMediaType(part.mimeType),
                    data: part.data,
                },
            };
        }
        if (part.type === 'file') {
            return { type: 'text', text: renderFilePart(part.name, part.content, part.isBinary) };
        }
        if (part.type === 'tool_use') {
            return {
                type: 'tool_use',
                id: part.id,
                name: part.name,
                input: part.input,
            };
        }
        if (part.type === 'tool_result') {
            return {
                type: 'tool_result',
                tool_use_id: part.tool_use_id,
                content: part.content,
                is_error: part.is_error,
            };
        }
        return { type: 'text', text: '' };
    });
}

function buildAnthropicMessages(messages: AiRequestOptions['messages']): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const message of messages) {
        // 将带 tool_calls 的助手消息转换为内容块
        if (message.role === 'assistant' && message.tool_calls) {
            const contentParts: Array<
                | { type: 'text'; text: string }
                | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
            > = [];

            // 如有文本内容则添加
            if (typeof message.content === 'string' && message.content) {
                contentParts.push({ type: 'text', text: message.content });
            }

            // 添加 tool_use 块
            for (const tc of message.tool_calls) {
                let input: Record<string, unknown>;
                try {
                    input = JSON.parse(tc.arguments);
                } catch {
                    input = {};
                }
                contentParts.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input,
                });
            }

            result.push({
                role: 'assistant' as const,
                content: contentParts,
            });
        } else if (message.role === 'tool') {
            // 将工具结果消息转换为带 tool_result 块的用户消息
            result.push({
                role: 'user' as const,
                content: [
                    {
                        type: 'tool_result' as const,
                        tool_use_id: message.tool_call_id!,
                        content: typeof message.content === 'string' ? message.content : '',
                    },
                ],
            });
        } else {
            // 普通消息
            result.push({
                role: message.role,
                content: mapAnthropicContent(message.content),
            } as Anthropic.MessageParam);
        }
    }

    return result;
}

function mapToolsToAnthropic(tools?: AiToolDefinition[]): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
    }));
}

export class AnthropicProvider implements AiProvider {
    name = 'Anthropic';
    type = 'anthropic' as const;
    private client: Anthropic;

    constructor(config: AiProviderConfig) {
        this.client = new Anthropic({
            apiKey: config.apiKey,
            baseURL: config.apiEndpoint,
            dangerouslyAllowBrowser: true,
            fetch: createTauriFetch(),
        });
    }

    async request(options: AiRequestOptions): Promise<AiResponse> {
        const messages = buildAnthropicMessages(options.messages);
        const tools = mapToolsToAnthropic(options.tools);
        const message = await this.client.messages.create({
            model: options.model,
            messages,
            tools,
            max_tokens: options.maxTokens || 4096,
            stream: false,
        });

        const firstBlock = message.content[0];
        const content = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';

        return {
            content,
            tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
            finishReason: message.stop_reason || undefined,
        };
    }

    async *stream(options: AiRequestOptions): AsyncGenerator<AiStreamChunk, void, unknown> {
        const messages = buildAnthropicMessages(options.messages);
        const tools = mapToolsToAnthropic(options.tools);
        const stream = await this.client.messages.create(
            {
                model: options.model,
                messages,
                tools,
                max_tokens: options.maxTokens || 4096,
                stream: true,
            },
            { signal: options.signal }
        );

        // 累积 tool use 块
        const toolUsesMap = new Map<
            number,
            { id: string; name: string; inputFromStart?: string; inputFromDelta: string }
        >();
        let currentBlockIndex = -1;
        let stopReason: string | undefined;

        for await (const event of stream) {
            // 跟踪内容块索引
            if (event.type === 'content_block_start') {
                currentBlockIndex = event.index;

                if (event.content_block.type === 'tool_use') {
                    toolUsesMap.set(currentBlockIndex, {
                        id: event.content_block.id,
                        name: event.content_block.name,
                        inputFromStart: serializeToolInput(event.content_block.input),
                        inputFromDelta: '',
                    });
                }
                continue;
            }

            // 处理 delta 内容块
            if (event.type === 'content_block_delta') {
                if (event.delta.type === 'thinking_delta') {
                    // 推理内容流式输出
                    yield { content: '', reasoning: event.delta.thinking, done: false };
                } else if (event.delta.type === 'text_delta') {
                    // 正常文本内容
                    yield { content: event.delta.text, done: false };
                } else if (event.delta.type === 'input_json_delta') {
                    // 累积工具输入 JSON
                    const existing = toolUsesMap.get(currentBlockIndex);
                    if (existing) {
                        existing.inputFromDelta += event.delta.partial_json;
                    }
                }
            } else if (event.type === 'message_delta') {
                // 捕获 Anthropic 返回的实际 stop_reason
                const delta = event.delta as { stop_reason?: string };
                if (delta.stop_reason) {
                    stopReason = delta.stop_reason;
                }
            } else if (event.type === 'message_stop') {
                const hasToolCalls = toolUsesMap.size > 0;
                const isToolUseStop = stopReason === 'tool_use';
                const toolCalls =
                    hasToolCalls && isToolUseStop
                        ? Array.from(toolUsesMap.values()).map((tu) => ({
                              id: tu.id,
                              name: tu.name,
                              arguments: tu.inputFromDelta || tu.inputFromStart || '{}',
                          }))
                        : undefined;

                yield {
                    content: '',
                    done: true,
                    finishReason: toolCalls ? 'tool_calls' : stopReason || 'end_turn',
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
            name: model.display_name || model.id,
        }));
    }
}
