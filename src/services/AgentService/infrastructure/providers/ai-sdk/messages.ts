// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    type ImagePart,
    jsonSchema,
    type ModelMessage,
    type TextPart,
    tool,
    type ToolCallPart,
    type ToolContent,
    type ToolSet,
    type UserContent,
} from 'ai';

import type { AiContentPart, AiMessage } from '@/services/AgentService/contracts/protocol';
import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';
import { safeParseJsonWithSchema, z } from '@/utils/zod';

import { normalizeToolName, toJsonSchema7 } from './utils';

const unknownJsonSchema = z.unknown();

/**
 * 把文件附件降级成文本块，避免各家 SDK 的文件协议差异把会话历史打碎。
 */
function renderFilePart(name: string, content: string, isBinary: boolean): string {
    const header = `[文件: ${name}]`;
    return isBinary ? `${header}\n(二进制 Base64)\n${content}` : `${header}\n${content}`;
}

function parseToolCallArguments(argumentsJson: string): unknown {
    return safeParseJsonWithSchema(unknownJsonSchema, argumentsJson, {});
}

function mapUserParts(content: AiContentPart[]): UserContent {
    const parts: Array<TextPart | ImagePart> = [];

    for (const part of content) {
        if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text });
            continue;
        }

        if (part.type === 'image') {
            parts.push({
                type: 'image',
                image: part.data,
                mediaType: part.mimeType,
            });
            continue;
        }

        if (part.type === 'file') {
            parts.push({
                type: 'text',
                text: renderFilePart(part.name, part.content, part.isBinary),
            });
        }
    }

    return parts;
}

function mapAssistantTextParts(
    content: AiMessage['content']
): Array<{ type: 'text'; text: string }> {
    if (!Array.isArray(content)) {
        return content ? [{ type: 'text', text: content }] : [];
    }

    return content.flatMap((part) => {
        if (part.type === 'text') {
            return [{ type: 'text' as const, text: part.text }];
        }

        if (part.type === 'file') {
            return [
                {
                    type: 'text' as const,
                    text: renderFilePart(part.name, part.content, part.isBinary),
                },
            ];
        }

        return [];
    });
}

/**
 * 把应用内部消息结构映射到 AI SDK 的通用消息格式。
 */
export function buildModelMessages(messages: AiMessage[]): ModelMessage[] {
    return messages.map((message): ModelMessage => {
        if (message.role === 'system') {
            return {
                role: 'system',
                content: typeof message.content === 'string' ? message.content : '',
            };
        }

        if (message.role === 'user') {
            return {
                role: 'user',
                content: Array.isArray(message.content)
                    ? mapUserParts(message.content)
                    : message.content,
            };
        }

        if (message.role === 'tool') {
            const toolContent = typeof message.content === 'string' ? message.content : '';
            // tool result 应保持和原始 tool call 的名字可关联。
            // 这里保留兜底值，避免历史脏数据把整轮请求直接打断。
            const toolName = message.name || 'unknown_tool';

            const content: ToolContent = [
                {
                    type: 'tool-result',
                    toolCallId: message.tool_call_id || '',
                    toolName,
                    output: {
                        type: 'text',
                        value: toolContent,
                    },
                },
            ];

            return {
                role: 'tool',
                content,
            };
        }

        const contentParts = mapAssistantTextParts(message.content);
        const toolCallParts: ToolCallPart[] =
            message.tool_calls?.flatMap((toolCall) => {
                const toolName = normalizeToolName(toolCall.name);
                if (!toolName) {
                    return [];
                }

                return [
                    {
                        type: 'tool-call' as const,
                        toolCallId: toolCall.id,
                        toolName,
                        input: parseToolCallArguments(toolCall.arguments),
                        providerOptions: toolCall.providerOptions,
                    },
                ];
            }) ?? [];

        if (contentParts.length === 0 && toolCallParts.length === 0) {
            return {
                role: 'assistant',
                content: '',
            };
        }

        if (toolCallParts.length === 0 && contentParts.length === 1) {
            return {
                role: 'assistant',
                content: contentParts[0]!.text,
            };
        }

        return {
            role: 'assistant',
            content: [...contentParts, ...toolCallParts],
        };
    });
}

/**
 * 将应用内部工具定义转换成 AI SDK ToolSet。
 */
export function buildToolSet(tools?: AiToolDefinition[]): ToolSet | undefined {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    return Object.fromEntries(
        tools.map((toolDefinition) => {
            const inputSchema = toJsonSchema7(toolDefinition.input_schema);
            if (!inputSchema) {
                throw new Error(`Invalid tool input schema: ${toolDefinition.name}`);
            }

            return [
                toolDefinition.name,
                tool({
                    description: toolDefinition.description,
                    inputSchema: jsonSchema(inputSchema),
                }),
            ];
        })
    );
}
