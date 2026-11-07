/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { log } from '@services/ObservabilityService';

import type { AiContentPart, AttachmentDerivedKind } from '../../contracts/protocol';
import {
    formatAttachmentAnchorText,
    readAttachmentAsBase64,
    readAttachmentAsText,
} from './content';
import type { AttachmentInspection } from './inspect';
import { inspectAttachments } from './inspect';
import { isAttachmentSupported } from './support';
import type { AttachmentIndex } from './types';

export interface AttachmentPreparedPayload {
    kind: AttachmentDerivedKind;
    mimeType: string;
    textContent?: string;
    base64Data?: string;
}

async function prepareAttachmentPayload(
    inspection: AttachmentInspection
): Promise<AttachmentPreparedPayload> {
    const { attachment, kind, mimeType } = inspection;
    if (kind === 'image' || kind === 'pdf') {
        const { data } = await readAttachmentAsBase64(attachment);
        return {
            kind,
            mimeType,
            base64Data: data,
        };
    }

    if (kind === 'directory') {
        return {
            kind,
            mimeType,
            textContent: `[Directory]\npath: ${attachment.originPath}`,
        };
    }

    const { content, isBinary } = await readAttachmentAsText(attachment);
    if (isBinary) {
        return {
            kind: 'binary',
            mimeType,
            base64Data: content,
        };
    }

    return {
        kind,
        mimeType,
        textContent: content,
    };
}

function pushMaterializedPart(
    parts: AiContentPart[],
    inspection: AttachmentInspection,
    payload: AttachmentPreparedPayload,
    options: { includeAnchorText?: boolean }
): void {
    const includeAnchorText = options.includeAnchorText ?? true;

    if (payload.kind === 'image') {
        if (includeAnchorText) {
            parts.push({
                type: 'text',
                text: formatAttachmentAnchorText(inspection.meta),
            });
        }
        parts.push({
            type: 'image',
            name: inspection.attachment.name,
            sourcePath: inspection.attachment.path,
            size: inspection.size,
            mimeType: payload.mimeType,
            data: payload.base64Data ?? '',
            kind: 'image',
            semanticIntent: inspection.semanticIntent,
            meta: inspection.meta,
        });
        return;
    }

    if (includeAnchorText) {
        parts.push({
            type: 'text',
            text: formatAttachmentAnchorText(inspection.meta),
        });
    }
    parts.push({
        type: 'file',
        name: inspection.attachment.name,
        sourcePath: inspection.attachment.path,
        size: inspection.size,
        mimeType: payload.mimeType,
        kind: payload.kind,
        semanticIntent: inspection.semanticIntent,
        textContent: payload.textContent,
        base64Data: payload.base64Data,
        meta: inspection.meta,
    });
}

export async function materializeAttachmentParts(
    inspections: AttachmentInspection[],
    options: {
        includeAnchorText?: boolean;
    } = {}
): Promise<AiContentPart[]> {
    const parts: AiContentPart[] = [];
    const payloadBySource = new Map<string, AttachmentPreparedPayload | null>();

    for (const inspection of inspections) {
        const sourceKey = JSON.stringify([
            inspection.attachment.path,
            inspection.kind,
            inspection.mimeType,
        ]);
        if (!payloadBySource.has(sourceKey)) {
            try {
                payloadBySource.set(sourceKey, await prepareAttachmentPayload(inspection));
            } catch (error) {
                log.error('[AttachmentMaterialize] Failed to read attachment:', error);
                payloadBySource.set(sourceKey, null);
            }
        }
        const payload = payloadBySource.get(sourceKey);
        if (payload) pushMaterializedPart(parts, inspection, payload, options);
    }

    return parts;
}

export async function buildAttachmentParts(
    attachments: AttachmentIndex[],
    options: {
        includeAnchorText?: boolean;
    } = {}
): Promise<AiContentPart[]> {
    const usableAttachments = attachments.filter((attachment) => isAttachmentSupported(attachment));
    const inspections = await inspectAttachments(usableAttachments);

    return materializeAttachmentParts(inspections, options);
}
