/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { getProviderAttachmentCapabilities } from '../catalog/capabilities';
import type {
    AiContentPart,
    AiMessage,
    MediaKind,
    MediaTransportDecision,
    MediaTransportMode,
} from '../contracts/message';
import type { ProviderDriver } from '../contracts/model';
const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024;

type AttachmentCarrierPart = Extract<AiContentPart, { type: 'image' | 'file' }>;

export interface AttachmentDeliveryPlanEntry {
    messageIndex: number;
    partIndex: number;
    role: 'user' | 'tool';
    messageContext: 'user' | 'tool-result';
    toolCallId?: string;
    toolName?: string;
    part: AttachmentCarrierPart;
    decision: MediaTransportDecision;
}

export interface AttachmentDeliveryPlan {
    providerDriver: ProviderDriver;
    modelId: string;
    entries: AttachmentDeliveryPlanEntry[];
}

export function buildMediaTransportDecision(options: {
    kind: MediaKind;
    size?: number;
    providerDriver: ProviderDriver;
    messageContext?: 'user' | 'tool-result';
}): MediaTransportDecision {
    const { kind, size, providerDriver, messageContext = 'user' } = options;
    const capabilities = getProviderAttachmentCapabilities(providerDriver);

    const resolveMessagePositionMode = (
        shouldHoistMedia: boolean
    ): MediaTransportDecision['messagePositionMode'] =>
        shouldHoistMedia &&
        messageContext === 'tool-result' &&
        !capabilities.supportsMediaInToolResults
            ? 'synthetic-user-hoist'
            : 'inline';

    if (kind === 'image') {
        // 当前 AI SDK + OpenAI chat 仅能把 `file-...` 识别成文档 file_id，
        // 图片字符串会被当成 base64 数据而不是远端引用，因此这里必须禁用。
        const supportsImageRemoteRef =
            capabilities.supportsProviderFileRef &&
            capabilities.fileRefStrategy !== 'openai-file-id';
        const shouldPreferFileRef =
            supportsImageRemoteRef &&
            typeof size === 'number' &&
            size > capabilities.maxInlineRequestBytes;
        return {
            kind,
            transportMode: shouldPreferFileRef ? 'provider-file-ref' : 'inline-image',
            reason: shouldPreferFileRef ? 'image-too-large-for-inline' : 'inline-image-default',
            shouldUpload: shouldPreferFileRef,
            canReuseRemoteRef: supportsImageRemoteRef,
            messagePositionMode: resolveMessagePositionMode(capabilities.supportsImageInput),
        };
    }

    if (kind === 'pdf') {
        if (typeof size === 'number' && size > MAX_INLINE_PDF_BYTES) {
            return {
                kind,
                transportMode: 'inline-text',
                reason: 'pdf-too-large-inline-path',
                shouldUpload: false,
                canReuseRemoteRef: false,
                messagePositionMode: 'inline',
            };
        }

        const shouldUseFileRef =
            capabilities.supportsProviderFileRef && capabilities.prefersFileRefForPdf;
        const canUseNativePdfInput =
            capabilities.supportsDocumentInput || capabilities.supportsProviderFileRef;
        return {
            kind,
            transportMode: shouldUseFileRef ? 'provider-file-ref' : 'inline-base64',
            reason: shouldUseFileRef ? 'pdf-prefers-provider-file-ref' : 'pdf-inline-fallback',
            shouldUpload: shouldUseFileRef,
            canReuseRemoteRef: capabilities.supportsProviderFileRef,
            messagePositionMode: resolveMessagePositionMode(canUseNativePdfInput),
        };
    }

    if (kind === 'text') {
        return {
            kind,
            transportMode: 'inline-text',
            reason: 'text-like-inline-default',
            shouldUpload: false,
            canReuseRemoteRef: false,
            messagePositionMode: 'inline',
        };
    }

    return {
        kind,
        transportMode: 'inline-text',
        reason: 'binary-text-fallback',
        shouldUpload: false,
        canReuseRemoteRef: false,
        messagePositionMode: 'inline',
    };
}

export function resolveDeliveredInlineTransportMode(
    part: AttachmentCarrierPart
): Exclude<MediaTransportMode, 'provider-file-ref' | 'external-url'> {
    if (part.type === 'image') {
        return 'inline-image';
    }

    return part.base64Data !== undefined && part.textContent === undefined
        ? 'inline-base64'
        : 'inline-text';
}

export function planAttachmentDeliveryForMessages(options: {
    messages: AiMessage[];
    providerDriver: ProviderDriver;
    modelId: string;
}): AttachmentDeliveryPlan {
    const entries: AttachmentDeliveryPlanEntry[] = [];

    options.messages.forEach((message, messageIndex) => {
        if (!Array.isArray(message.content)) {
            return;
        }

        const messageContext =
            message.role === 'tool' ? 'tool-result' : message.role === 'user' ? 'user' : null;
        if (!messageContext) {
            return;
        }

        message.content.forEach((part, partIndex) => {
            if (part.type !== 'image' && part.type !== 'file') {
                return;
            }

            entries.push({
                messageIndex,
                partIndex,
                role: message.role === 'tool' ? 'tool' : 'user',
                messageContext,
                toolCallId: message.tool_call_id,
                toolName: message.name,
                part,
                decision: buildMediaTransportDecision({
                    kind: part.kind,
                    size: part.size ?? undefined,
                    providerDriver: options.providerDriver,
                    messageContext,
                }),
            });
        });
    });

    return {
        providerDriver: options.providerDriver,
        modelId: options.modelId,
        entries,
    };
}

export function getAttachmentDeliveryPlanEntry(
    plan: AttachmentDeliveryPlan,
    messageIndex: number,
    partIndex: number
): AttachmentDeliveryPlanEntry | null {
    return (
        plan.entries.find(
            (entry) => entry.messageIndex === messageIndex && entry.partIndex === partIndex
        ) ?? null
    );
}

export function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer;
}
