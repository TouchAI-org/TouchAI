import type {
    AiRequestOptions as ProviderRequest,
    ProviderDriver,
} from '@touchai/models/contracts';

import {
    createAttachmentDeliveryManifestRequest,
    restoreDeliveryManifest,
    toProviderMedia,
} from '@/modules/attachments';

import type { DesktopModelRequest as AiRequestOptions } from './input';
import { appendModelToolLanguage } from './language';

export function prepareModelRequest(
    input: AiRequestOptions,
    connection: {
        driver: ProviderDriver;
        providerId?: number;
        resourceKey(attachmentId: number): string | undefined;
    }
): ProviderRequest {
    const messages = structuredClone(input.messages);
    const modelId = input.model;
    const requestIndex = input.attachmentRequestIndex ?? 0;
    const resolveManifest = input.onAttachmentManifestResolved;
    return {
        model: input.model,
        messages: messages.map((message) => ({
            role: message.role,
            content: Array.isArray(message.content)
                ? message.content.map((part) =>
                      part.type === 'file' || part.type === 'image'
                          ? toProviderMedia(
                                part,
                                part.meta.attachmentId
                                    ? connection.resourceKey(part.meta.attachmentId)
                                    : undefined
                            )
                          : part
                  )
                : message.content,
            ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            ...(message.name ? { name: message.name } : {}),
            ...(message.isError !== undefined ? { isError: message.isError } : {}),
        })),
        promptCacheKey: input.promptCacheKey,
        maxOutputTokens: input.maxOutputTokens,
        toolChoice: input.toolChoice,
        supportsReasoning: input.supportsReasoning,
        reasoningLevel: input.reasoningLevel,
        reasoningOptions: input.reasoningOptions,
        stream: input.stream,
        signal: input.signal,
        tools: input.tools?.map((tool) => ({
            name: tool.name,
            description: input.modelLanguageContext
                ? appendModelToolLanguage(tool.description, input.modelLanguageContext)
                : tool.description,
            input_schema: structuredClone(tool.input_schema),
        })),
        onTransportResolved: async (observations) => {
            await resolveManifest?.(
                createAttachmentDeliveryManifestRequest(
                    restoreDeliveryManifest({
                        driver: connection.driver,
                        providerId: connection.providerId ?? null,
                        modelId,
                        requestIndex,
                        messages,
                        observations,
                    })
                )
            );
        },
    };
}
