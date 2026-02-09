// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { createTauriFetch } from '@services/AiService/providers/shared/tauri-fetch';
import OpenAI from 'openai';

import type {
    AiProvider,
    AiProviderConfig,
    AiRequestOptions,
    AiResponse,
    AiStreamChunk,
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
        return { type: 'text', text: renderFilePart(part.name, part.content, part.isBinary) };
    });
}

function buildOpenAiMessages(
    messages: AiRequestOptions['messages']
): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((message) => ({
        role: message.role,
        content: mapOpenAiContent(message.content),
    })) as OpenAI.Chat.ChatCompletionMessageParam[];
}

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
        const completion = await this.client.chat.completions.create({
            model: options.model,
            messages,
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
        const stream = await this.client.chat.completions.create({
            model: options.model,
            messages,
            stream: true,
        });

        for await (const chunk of stream) {
            //官方客户端没有提供Reasoning的类型，做适配
            const delta = chunk.choices[0]?.delta as {
                reasoning_content?: string;
            } & OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta;

            const content = delta?.content || '';
            const reasoning = delta?.reasoning_content || '';
            const finishReason = chunk.choices[0]?.finish_reason;

            if (reasoning) {
                yield { content: '', reasoning, done: false };
            }

            if (content) {
                yield { content, done: false };
            }

            if (finishReason) {
                yield { content: '', done: true };
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
