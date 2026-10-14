// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getMessageText } from '@database/queries/messageParts';
import { findMessagesBySessionId } from '@database/queries/messages';
import { getToolCallName, readToolCallData } from '@database/queries/toolParts';
import type { MessagePartEntity } from '@database/types';

import type { AiContentPart, AiMessage, JsonObject } from '../contracts/protocol';
import type { AiToolCall } from '../contracts/tooling';
import {
    type AttachmentCapabilities,
    type AttachmentType,
    buildAttachmentParts,
    getUnsupportedAttachmentTypes,
    hydratePersistedAttachments,
} from '../infrastructure/attachments';

/** 读取 reasoning 片段持久化的 providerOptions；无有效内容时返回 undefined。 */
function readReasoningProviderOptions(data: string): Record<string, JsonObject> | undefined {
    if (!data || data === '{}') return undefined;
    try {
        const parsed = JSON.parse(data) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        const entries = Object.entries(parsed as Record<string, unknown>);
        if (entries.length === 0) return undefined;
        return parsed as Record<string, JsonObject>;
    } catch {
        return undefined;
    }
}

function buildAssistantTransportContent(row: { parts: MessagePartEntity[] }): AiMessage['content'] {
    return row.parts.flatMap((part): AiContentPart[] => {
        if (part.type === 'text' && part.content.trim()) {
            return [{ type: 'text', text: part.content }];
        }
        if (part.type === 'reasoning' && part.content.trim()) {
            const providerOptions = readReasoningProviderOptions(part.data);
            return [
                {
                    type: 'reasoning',
                    text: part.content,
                    ...(providerOptions ? { providerOptions } : {}),
                },
            ];
        }
        return [];
    });
}

const MISSING_TOOL_RESULT_PLACEHOLDER = 'Missing historical tool result.';

export async function findUnsupportedSessionAttachmentTypes(options: {
    sessionId?: number;
    capabilities: AttachmentCapabilities;
}): Promise<AttachmentType[]> {
    if (!options.sessionId) {
        return [];
    }

    const rows = await findMessagesBySessionId(options.sessionId);
    const transportAttachmentRows = rows
        .filter((row) => row.role === 'user' || row.role === 'tool_result')
        .flatMap((row) => row.attachments);

    return getUnsupportedAttachmentTypes(transportAttachmentRows, options.capabilities);
}

function resolveTransportAttachmentCapabilities(options: {
    attachmentCapabilities?: AttachmentCapabilities;
    supportsAttachments?: boolean;
}): AttachmentCapabilities {
    if (options.attachmentCapabilities) {
        return options.attachmentCapabilities;
    }

    const supportsAttachments = options.supportsAttachments ?? true;
    return {
        supportsImages: supportsAttachments,
        supportsFiles: supportsAttachments,
    };
}

function filterSupportedAttachmentRows<T extends { type: AttachmentType }>(
    attachments: T[],
    capabilities: AttachmentCapabilities
): T[] {
    return attachments.filter(
        (attachment) => getUnsupportedAttachmentTypes([attachment], capabilities).length === 0
    );
}

/**
 * 将会话历史重组为下一轮请求可继续复用的模型消息。
 */
export async function loadSessionTransportMessages(options: {
    sessionId?: number;
    supportsAttachments?: boolean;
    attachmentCapabilities?: AttachmentCapabilities;
}): Promise<AiMessage[]> {
    const rows = options.sessionId ? await findMessagesBySessionId(options.sessionId) : [];
    const attachmentCapabilities = resolveTransportAttachmentCapabilities(options);
    const messages: AiMessage[] = [];
    const pendingResultToolCalls: AiToolCall[] = [];

    const takePendingResultToolCall = (part?: MessagePartEntity): AiToolCall | undefined => {
        if (!part?.tool_call_id || !part.tool_kind) return undefined;
        const index = pendingResultToolCalls.findIndex(
            (call) => call.id === part.tool_call_id && call.name.startsWith(`${part.tool_kind}__`)
        );
        return index < 0 ? undefined : pendingResultToolCalls.splice(index, 1)[0];
    };

    const flushMissingToolResults = (): void => {
        while (pendingResultToolCalls.length > 0) {
            const toolCall = pendingResultToolCalls.shift()!;
            messages.push({
                role: 'tool',
                content: MISSING_TOOL_RESULT_PLACEHOLDER,
                tool_call_id: toolCall.id,
                name: toolCall.name,
            });
        }
    };

    for (const row of rows) {
        if (row.role === 'tool_call') {
            flushMissingToolResults();
            const calls: AiToolCall[] = row.parts
                .filter((part) => part.type === 'tool_call')
                .map((part) => {
                    const data = readToolCallData(part);
                    return {
                        id: data.toolCallId,
                        name: getToolCallName(data),
                        arguments: data.input,
                    };
                });
            messages.push({
                role: 'assistant',
                content: buildAssistantTransportContent(row),
                tool_calls: calls,
            });
            pendingResultToolCalls.push(...calls);
            continue;
        }
        if (row.role === 'tool_result') {
            const part = row.parts.find((part) => part.type === 'tool_result');
            const call = takePendingResultToolCall(part);
            if (!call) {
                console.warn(
                    '[SessionTransport] Cannot resolve tool_result, skipping message:',
                    row.id
                );
                continue;
            }
            const supported = filterSupportedAttachmentRows(
                row.attachments,
                attachmentCapabilities
            );
            const attachments = supported.length
                ? await hydratePersistedAttachments(supported)
                : [];
            const attachmentParts = attachments.length
                ? await buildAttachmentParts(attachments, { includeAnchorText: false })
                : [];
            const content = getMessageText(row.parts);
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: attachmentParts.length
                    ? [
                          ...(content ? [{ type: 'text' as const, text: content }] : []),
                          ...attachmentParts,
                      ]
                    : content,
            });
            continue;
        }

        if (row.role === 'user') {
            flushMissingToolResults();

            const supportedAttachmentRows = filterSupportedAttachmentRows(
                row.attachments,
                attachmentCapabilities
            );
            const attachments =
                supportedAttachmentRows.length > 0
                    ? await hydratePersistedAttachments(supportedAttachmentRows)
                    : [];
            const attachmentParts =
                attachments.length > 0 ? await buildAttachmentParts(attachments) : [];

            messages.push({
                role: 'user',
                content:
                    attachmentParts.length > 0
                        ? ([
                              { type: 'text', text: getMessageText(row.parts) },
                              ...attachmentParts,
                          ] as AiContentPart[])
                        : getMessageText(row.parts),
            });
            continue;
        }

        flushMissingToolResults();

        messages.push({
            role: row.role as 'user' | 'assistant' | 'system',
            content:
                row.role === 'assistant'
                    ? buildAssistantTransportContent(row)
                    : getMessageText(row.parts),
        });
    }

    flushMissingToolResults();

    return messages;
}
