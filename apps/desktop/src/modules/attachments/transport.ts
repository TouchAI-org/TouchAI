import type {
    AiContentPart,
    MediaTransportObservation,
    ProviderDriver,
} from '@touchai/models/contracts';

import type { AttachmentContentPart, AttachmentDeliveryManifestRequest } from './contracts';
import { buildAttachmentTransportDecision } from './planner';
import { formatAttachmentAnchorText, formatAttachmentNotInlined } from './prompt';

type Media = Extract<AttachmentContentPart, { type: 'file' | 'image' }>;

/** Local semantic instructions and database references stay on the Desktop side. */
export function toProviderMedia(part: Media, resourceKey?: string): AiContentPart {
    const base = {
        name: part.name,
        size: part.size,
        mimeType: part.mimeType,
        ...(resourceKey ? { resourceKey } : {}),
        anchorText: formatAttachmentAnchorText(part.meta),
    };
    if (part.type === 'image') {
        return {
            ...base,
            type: 'image',
            kind: 'image',
            data: part.data,
            fallbackText: formatAttachmentNotInlined(
                'image data is unavailable',
                part.meta.originPath
            ),
            toolFallbackText: `[Attachment ${part.meta.alias} image]\nmedia_type: ${part.mimeType}`,
        };
    }
    return {
        ...base,
        type: 'file',
        kind: part.kind === 'pdf' ? 'pdf' : part.kind === 'binary' ? 'binary' : 'text',
        ...(part.base64Data !== undefined ? { base64Data: part.base64Data } : {}),
        ...(part.textContent !== undefined
            ? {
                  textContent: `[Attachment ${part.meta.alias} content]\n${part.textContent}`,
              }
            : {}),
        fallbackText:
            part.base64Data !== undefined && part.textContent === undefined
                ? formatAttachmentNotInlined('binary content', part.meta.originPath)
                : `[Attachment ${part.meta.alias} content]\n${part.textContent ?? ''}`,
    };
}

export function restoreDeliveryManifest(options: {
    driver: ProviderDriver;
    providerId: number | null;
    modelId: string;
    requestIndex: number;
    messages: {
        role: string;
        content: string | AttachmentContentPart[];
        tool_call_id?: string;
        name?: string;
    }[];
    observations: readonly MediaTransportObservation[];
}): Omit<AttachmentDeliveryManifestRequest, 'createdAt'> {
    return {
        requestIndex: options.requestIndex,
        providerDriver: options.driver,
        providerId: options.providerId,
        modelId: options.modelId,
        entries: options.observations.map((observation) => {
            const message = options.messages[observation.messageIndex];
            const part = Array.isArray(message?.content)
                ? message.content[observation.partIndex]
                : undefined;
            if (!part || (part.type !== 'file' && part.type !== 'image')) {
                throw new Error('Provider transport observation does not identify a media input');
            }
            const decision = buildAttachmentTransportDecision({
                kind: part.kind,
                size: part.size ?? undefined,
                providerDriver: options.driver,
                messageContext: observation.messageContext,
            });
            return {
                messageIndex: observation.messageIndex,
                partIndex: observation.partIndex,
                sourceRole: observation.sourceRole,
                resolvedRole: observation.resolvedRole,
                messageContext: observation.messageContext,
                toolCallId: message?.tool_call_id,
                toolName: message?.name,
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
                transportMode: observation.transportMode,
                messagePositionMode: observation.messagePositionMode,
                transportReason: decision.reason,
                remoteRefStrategy: observation.remoteRefStrategy,
            };
        }),
    };
}
