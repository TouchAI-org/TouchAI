// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';
import {
    type FilePart,
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

import type {
    AiContentPart,
    AiMessage,
    AttachmentDeliveryManifestEntry,
    AttachmentDeliveryManifestRequest,
    AttachmentPromptMeta,
} from '@/services/AgentService/contracts/protocol';
import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';
import {
    type AttachmentDeliveryPlan,
    type AttachmentDeliveryPlanEntry,
    createAttachmentDeliveryManifestRequest,
    formatAttachmentAnchorText,
    getAttachmentDeliveryPlanEntry,
    planAttachmentDeliveryForMessages,
    resolveDeliveredInlineTransportMode,
} from '@/services/AgentService/infrastructure/attachments';
import { getProviderAttachmentCapabilities } from '@/services/AgentService/infrastructure/providers';
import { safeParseJsonWithSchema, z } from '@/utils/zod';

import type { ProviderAttachmentRemoteRef, ProviderAttachmentRequestContext } from './attachments';
import { resolveProviderAttachmentRemoteRef } from './attachments';
import { normalizeToolName, toJsonSchema7 } from './utils';

const unknownJsonSchema = z.unknown();
const TOOL_RESULT_HOIST_NOTICE = '[Tool result media hoisted to following user message]';

type AttachmentCarrierPart = Extract<AiContentPart, { type: 'image' | 'file' }>;
type ToolOutputContentPart =
    | { type: 'text'; text: string }
    | { type: 'file-data'; data: string; mediaType: string; filename?: string }
    | { type: 'file-url'; url: string }
    | { type: 'file-id'; fileId: string | Record<string, string> }
    | { type: 'image-data'; data: string; mediaType: string }
    | { type: 'image-url'; url: string }
    | { type: 'image-file-id'; fileId: string | Record<string, string> };

interface UserAttachmentMappingResult {
    contentPart: TextPart | ImagePart | FilePart;
    manifestEntry: AttachmentDeliveryManifestEntry;
}

type ToolAttachmentMappingResult =
    | { type: 'hoist' }
    | {
          type: 'media';
          output: ToolOutputContentPart;
          manifestEntry: AttachmentDeliveryManifestEntry;
      }
    | {
          type: 'text';
          text: string;
          manifestEntry: AttachmentDeliveryManifestEntry;
      };

function renderFilePart(
    part: Extract<AiContentPart, { type: 'file' }>,
    meta?: AttachmentPromptMeta
): string {
    const isBinary = part.base64Data !== undefined && part.textContent === undefined;
    const content = part.textContent ?? part.base64Data ?? '';
    const header = meta
        ? `[Attachment ${meta.alias} content${isBinary ? ' | binary base64' : ''}]`
        : `[文件: ${part.name}]`;
    return isBinary && !meta ? `${header}\n(二进制 Base64)\n${content}` : `${header}\n${content}`;
}

function parseToolCallArguments(argumentsJson: string): unknown {
    return safeParseJsonWithSchema(unknownJsonSchema, argumentsJson, {});
}

function buildSdkRemoteRefPart(
    part: AttachmentCarrierPart,
    remoteRef: ProviderAttachmentRemoteRef
): FilePart {
    return {
        type: 'file',
        data: remoteRef.strategy === 'url' ? new URL(remoteRef.value) : remoteRef.value,
        filename: part.name,
        mediaType: part.mimeType,
    };
}

function buildToolRemoteRefOutputPart(
    part: AttachmentCarrierPart,
    remoteRef: ProviderAttachmentRemoteRef
): ToolOutputContentPart {
    if (remoteRef.strategy === 'url') {
        return part.type === 'image'
            ? {
                  type: 'image-url',
                  url: remoteRef.value,
              }
            : {
                  type: 'file-url',
                  url: remoteRef.value,
              };
    }

    return part.type === 'image'
        ? {
              type: 'image-file-id',
              fileId: remoteRef.value,
          }
        : {
              type: 'file-id',
              fileId: remoteRef.value,
          };
}

function buildManifestEntry(options: {
    planEntry: AttachmentDeliveryPlanEntry;
    resolvedRole: 'user' | 'tool';
    transportMode: AttachmentDeliveryManifestEntry['transportMode'];
    remoteRefStrategy?: string | null;
}): AttachmentDeliveryManifestEntry {
    const { planEntry, resolvedRole, transportMode, remoteRefStrategy = null } = options;
    const { part, decision } = planEntry;

    return {
        messageIndex: planEntry.messageIndex,
        partIndex: planEntry.partIndex,
        sourceRole: planEntry.role,
        resolvedRole,
        messageContext: planEntry.messageContext,
        toolCallId: planEntry.toolCallId,
        toolName: planEntry.toolName,
        alias: part.meta.alias,
        order: part.meta.order,
        type: part.meta.type,
        name: part.name,
        size: part.size,
        mimeType: part.mimeType,
        originPath: part.meta.originPath,
        sourcePath: part.sourcePath,
        attachmentId: part.meta.attachmentId,
        hash: part.meta.hash,
        derivedKind: part.kind,
        semanticIntent: part.semanticIntent,
        transportMode,
        messagePositionMode: decision.messagePositionMode,
        transportReason: decision.reason,
        remoteRefStrategy,
    };
}

async function mapUserAttachmentPart(
    part: AttachmentCarrierPart,
    planEntry: AttachmentDeliveryPlanEntry,
    context: {
        providerDriver: ProviderDriver;
        attachmentContext?: ProviderAttachmentRequestContext;
        resolvedRole?: 'user' | 'tool';
    }
): Promise<UserAttachmentMappingResult> {
    const capabilities = getProviderAttachmentCapabilities(context.providerDriver);
    const remoteRef =
        context.attachmentContext &&
        capabilities.supportsProviderFileRef &&
        (planEntry.decision.canReuseRemoteRef || planEntry.decision.shouldUpload)
            ? await resolveProviderAttachmentRemoteRef(
                  part,
                  planEntry.decision,
                  context.attachmentContext
              )
            : null;

    if (remoteRef) {
        return {
            contentPart: buildSdkRemoteRefPart(part, remoteRef),
            manifestEntry: buildManifestEntry({
                planEntry,
                resolvedRole: context.resolvedRole ?? 'user',
                transportMode: 'provider-file-ref',
                remoteRefStrategy: remoteRef.strategy,
            }),
        };
    }

    if (part.type === 'image') {
        return {
            contentPart: {
                type: 'image',
                image: part.data,
                mediaType: part.mimeType,
            },
            manifestEntry: buildManifestEntry({
                planEntry,
                resolvedRole: context.resolvedRole ?? 'user',
                transportMode: 'inline-image',
            }),
        };
    }

    if (part.kind === 'pdf' && capabilities.supportsDocumentInput && part.base64Data) {
        return {
            contentPart: {
                type: 'file',
                data: part.base64Data,
                filename: part.name,
                mediaType: part.mimeType,
            },
            manifestEntry: buildManifestEntry({
                planEntry,
                resolvedRole: context.resolvedRole ?? 'user',
                transportMode: 'inline-base64',
            }),
        };
    }

    return {
        contentPart: {
            type: 'text',
            text: renderFilePart(part, part.meta),
        },
        manifestEntry: buildManifestEntry({
            planEntry,
            resolvedRole: context.resolvedRole ?? 'user',
            transportMode: resolveDeliveredInlineTransportMode(part),
        }),
    };
}

async function mapUserParts(
    content: AiContentPart[],
    deliveryPlan: AttachmentDeliveryPlan,
    context: {
        providerDriver: ProviderDriver;
        attachmentContext?: ProviderAttachmentRequestContext;
    },
    messageIndex: number,
    manifestEntries: AttachmentDeliveryManifestEntry[]
): Promise<UserContent> {
    const parts: Array<TextPart | ImagePart | FilePart> = [];

    for (const [partIndex, part] of content.entries()) {
        if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text });
            continue;
        }

        if (part.type !== 'image' && part.type !== 'file') {
            continue;
        }

        const planEntry = getAttachmentDeliveryPlanEntry(deliveryPlan, messageIndex, partIndex);
        if (!planEntry) {
            continue;
        }

        const mapped = await mapUserAttachmentPart(part, planEntry, context);
        parts.push(mapped.contentPart);
        manifestEntries.push(mapped.manifestEntry);
    }

    return parts;
}

async function mapToolAttachmentPart(
    part: AttachmentCarrierPart,
    planEntry: AttachmentDeliveryPlanEntry,
    context: {
        providerDriver: ProviderDriver;
        attachmentContext?: ProviderAttachmentRequestContext;
    }
): Promise<ToolAttachmentMappingResult> {
    const capabilities = getProviderAttachmentCapabilities(context.providerDriver);

    if (planEntry.decision.messagePositionMode === 'synthetic-user-hoist') {
        return { type: 'hoist' };
    }

    const remoteRef =
        context.attachmentContext &&
        capabilities.supportsProviderFileRef &&
        (planEntry.decision.canReuseRemoteRef || planEntry.decision.shouldUpload)
            ? await resolveProviderAttachmentRemoteRef(
                  part,
                  planEntry.decision,
                  context.attachmentContext
              )
            : null;

    if (remoteRef) {
        return {
            type: 'media',
            output: buildToolRemoteRefOutputPart(part, remoteRef),
            manifestEntry: buildManifestEntry({
                planEntry,
                resolvedRole: 'tool',
                transportMode: 'provider-file-ref',
                remoteRefStrategy: remoteRef.strategy,
            }),
        };
    }

    if (part.type === 'image' && capabilities.supportsImageInput) {
        return {
            type: 'media',
            output: {
                type: 'image-data',
                data: part.data,
                mediaType: part.mimeType,
            },
            manifestEntry: buildManifestEntry({
                planEntry,
                resolvedRole: 'tool',
                transportMode: 'inline-image',
            }),
        };
    }

    if (part.kind === 'pdf' && capabilities.supportsDocumentInput && part.base64Data) {
        return {
            type: 'media',
            output: {
                type: 'file-data',
                data: part.base64Data,
                filename: part.name,
                mediaType: part.mimeType,
            },
            manifestEntry: buildManifestEntry({
                planEntry,
                resolvedRole: 'tool',
                transportMode: 'inline-base64',
            }),
        };
    }

    return {
        type: 'text',
        text:
            part.type === 'file'
                ? renderFilePart(part, part.meta)
                : `[Attachment ${part.meta.alias} image]\nmedia_type: ${part.mimeType}`,
        manifestEntry: buildManifestEntry({
            planEntry,
            resolvedRole: 'tool',
            transportMode: resolveDeliveredInlineTransportMode(part),
        }),
    };
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
                    text: renderFilePart(part, part.meta),
                },
            ];
        }

        return [];
    });
}

function buildToolResultHoistNotice(message: Pick<AiMessage, 'name' | 'tool_call_id'>): string {
    const lines = ['[Tool result attachments]', `tool: ${message.name || 'unknown_tool'}`];

    if (message.tool_call_id) {
        lines.push(`tool_call_id: ${message.tool_call_id}`);
    }

    return lines.join('\n');
}

async function mapToolMessage(
    message: AiMessage,
    deliveryPlan: AttachmentDeliveryPlan,
    context: {
        providerDriver: ProviderDriver;
        attachmentContext?: ProviderAttachmentRequestContext;
    },
    messageIndex: number,
    manifestEntries: AttachmentDeliveryManifestEntry[]
): Promise<ModelMessage[]> {
    const toolName = message.name || 'unknown_tool';

    if (!Array.isArray(message.content)) {
        const content: ToolContent = [
            {
                type: 'tool-result',
                toolCallId: message.tool_call_id || '',
                toolName,
                output: {
                    type: 'text',
                    value: message.content,
                },
            },
        ];

        return [
            {
                role: 'tool',
                content,
            },
        ];
    }

    const outputParts: ToolOutputContentPart[] = [];
    const hoistedAttachments: Array<{
        part: AttachmentCarrierPart;
        planEntry: AttachmentDeliveryPlanEntry;
    }> = [];

    for (const [partIndex, part] of message.content.entries()) {
        if (part.type === 'text') {
            outputParts.push({ type: 'text', text: part.text });
            continue;
        }

        if (part.type !== 'image' && part.type !== 'file') {
            continue;
        }

        const planEntry = getAttachmentDeliveryPlanEntry(deliveryPlan, messageIndex, partIndex);
        if (!planEntry) {
            continue;
        }

        const mappedPart = await mapToolAttachmentPart(part, planEntry, context);
        if (mappedPart.type === 'hoist') {
            hoistedAttachments.push({ part, planEntry });
            continue;
        }

        outputParts.push({
            type: 'text',
            text: formatAttachmentAnchorText(part.meta),
        });
        manifestEntries.push(mappedPart.manifestEntry);

        if (mappedPart.type === 'text') {
            outputParts.push({
                type: 'text',
                text: mappedPart.text,
            });
            continue;
        }

        outputParts.push(mappedPart.output);
    }

    const content: ToolContent = [
        {
            type: 'tool-result',
            toolCallId: message.tool_call_id || '',
            toolName,
            output:
                outputParts.length === 0
                    ? {
                          type: 'text',
                          value: hoistedAttachments.length > 0 ? TOOL_RESULT_HOIST_NOTICE : '',
                      }
                    : outputParts.length === 1 && outputParts[0]!.type === 'text'
                      ? {
                            type: 'text',
                            value: outputParts[0]!.text,
                        }
                      : {
                            type: 'content',
                            value: outputParts,
                        },
        },
    ];

    const mappedMessages: ModelMessage[] = [
        {
            role: 'tool',
            content,
        },
    ];

    if (hoistedAttachments.length > 0) {
        const hoistedContent: UserContent = [
            {
                type: 'text',
                text: buildToolResultHoistNotice(message),
            },
        ];

        for (const hoistedAttachment of hoistedAttachments) {
            hoistedContent.push({
                type: 'text',
                text: formatAttachmentAnchorText(hoistedAttachment.part.meta),
            });
            const mapped = await mapUserAttachmentPart(
                hoistedAttachment.part,
                hoistedAttachment.planEntry,
                {
                    providerDriver: context.providerDriver,
                    attachmentContext: context.attachmentContext,
                    resolvedRole: 'user',
                }
            );
            hoistedContent.push(mapped.contentPart);
            manifestEntries.push(mapped.manifestEntry);
        }

        mappedMessages.push({
            role: 'user',
            content: hoistedContent,
        });
    }

    return mappedMessages;
}

export interface BuildModelMessagesResult {
    messages: ModelMessage[];
    manifestRequest: AttachmentDeliveryManifestRequest;
}

interface BuildModelMessagesOptions {
    messages: AiMessage[];
    providerDriver: ProviderDriver;
    providerId?: number;
    modelId: string;
    attachmentContext?: ProviderAttachmentRequestContext;
    attachmentRequestIndex?: number;
}

export async function buildModelMessages(
    options: BuildModelMessagesOptions
): Promise<BuildModelMessagesResult> {
    const mappedMessages: ModelMessage[] = [];
    const manifestEntries: AttachmentDeliveryManifestEntry[] = [];
    const deliveryPlan = planAttachmentDeliveryForMessages({
        messages: options.messages,
        providerDriver: options.providerDriver,
        providerId: options.providerId,
        modelId: options.modelId,
    });

    for (const [messageIndex, message] of options.messages.entries()) {
        if (message.role === 'system') {
            mappedMessages.push({
                role: 'system',
                content: typeof message.content === 'string' ? message.content : '',
            });
            continue;
        }

        if (message.role === 'user') {
            mappedMessages.push({
                role: 'user',
                content: Array.isArray(message.content)
                    ? await mapUserParts(
                          message.content,
                          deliveryPlan,
                          {
                              providerDriver: options.providerDriver,
                              attachmentContext: options.attachmentContext,
                          },
                          messageIndex,
                          manifestEntries
                      )
                    : message.content,
            });
            continue;
        }

        if (message.role === 'tool') {
            mappedMessages.push(
                ...(await mapToolMessage(
                    message,
                    deliveryPlan,
                    {
                        providerDriver: options.providerDriver,
                        attachmentContext: options.attachmentContext,
                    },
                    messageIndex,
                    manifestEntries
                ))
            );
            continue;
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
            mappedMessages.push({
                role: 'assistant',
                content: '',
            });
            continue;
        }

        if (toolCallParts.length === 0 && contentParts.length === 1) {
            mappedMessages.push({
                role: 'assistant',
                content: contentParts[0]!.text,
            });
            continue;
        }

        mappedMessages.push({
            role: 'assistant',
            content: [...contentParts, ...toolCallParts],
        });
    }

    return {
        messages: mappedMessages,
        manifestRequest: createAttachmentDeliveryManifestRequest({
            requestIndex: options.attachmentRequestIndex ?? 0,
            providerDriver: options.providerDriver,
            providerId: options.providerId ?? null,
            modelId: options.modelId,
            entries: manifestEntries,
        }),
    };
}

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
