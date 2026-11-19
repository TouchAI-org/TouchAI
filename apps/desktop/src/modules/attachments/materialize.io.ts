/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { awaitAbortable } from '@/utils/abort';

import {
    formatAttachmentAnchorText,
    formatAttachmentNotInlined,
    readAttachmentAsBase64,
    readAttachmentAsText,
    readAttachmentImageForTransport,
} from './content.io';
import type { AttachmentContentPart as AiContentPart, AttachmentDerivedKind } from './contracts';
import type { AttachmentInspection } from './inspect.io';
import { inspectAttachments } from './inspect.io';
import {
    MAX_INLINE_IMAGE_BASE64_CHARS,
    MAX_INLINE_PDF_BASE64_CHARS,
    MAX_INLINE_PDF_BYTES,
    MAX_INLINE_PDF_TOTAL_BASE64_CHARS,
    MAX_INLINE_TEXT_CHARS,
    MAX_INLINE_TEXT_READ_BYTES,
    MAX_INLINE_TEXT_TOTAL_CHARS,
} from './limits';
import { isAttachmentSupported } from './support';
import type { AttachmentIndex } from './types';

export interface AttachmentPreparedPayload {
    kind: AttachmentDerivedKind;
    mimeType: string;
    textContent?: string;
    base64Data?: string;
    /** Long-form local text that shares the per-message text budget. */
    inlineText?: boolean;
}

interface AttachmentPayloadBudget {
    textChars: number;
    pdfBase64Chars: number;
}

export interface AttachmentMaterializeOptions {
    signal?: AbortSignal;
    diagnostics?: { error(message: string, error: unknown): void };
    includeAnchorText?: boolean;
    /** Keep tool-result files readable inline; user attachments stay path-only. */
    inlineFileContents?: boolean;
}

const truncationNotice = (shown: number, path: string): string =>
    `\n\n[Content truncated to ${shown} characters to keep the request within the model context. Use the Read tool with ${path} to read more.]`;

async function prepareAttachmentPayload(
    inspection: AttachmentInspection,
    options: AttachmentMaterializeOptions
): Promise<AttachmentPreparedPayload> {
    const { attachment, kind, mimeType } = inspection;
    if (kind === 'image') {
        const { data, mimeType: transportMimeType } = await readAttachmentImageForTransport(
            attachment,
            { signal: options.signal }
        );
        if (data.length > MAX_INLINE_IMAGE_BASE64_CHARS) {
            return {
                kind,
                mimeType: transportMimeType,
                textContent: formatAttachmentNotInlined(
                    'the image exceeds the inline transport limit',
                    attachment.originPath
                ),
            };
        }
        return {
            kind,
            mimeType: transportMimeType,
            base64Data: data,
        };
    }

    if (!options.inlineFileContents) {
        return {
            kind,
            mimeType,
            textContent: formatAttachmentNotInlined(
                kind === 'directory'
                    ? 'directory is referenced by path'
                    : 'file is referenced by path',
                attachment.originPath,
                kind === 'binary' ? 'Bash' : 'Read'
            ),
        };
    }

    if (kind === 'pdf') {
        if (attachment.size !== undefined && attachment.size > MAX_INLINE_PDF_BYTES) {
            return {
                kind,
                mimeType,
                textContent: formatAttachmentNotInlined(
                    'the PDF exceeds the inline transport limit',
                    attachment.originPath
                ),
            };
        }
        const base64 = await readAttachmentAsBase64(attachment, {
            maxBytes: MAX_INLINE_PDF_BYTES,
            signal: options.signal,
        });
        if (!base64 || base64.data.length > MAX_INLINE_PDF_BASE64_CHARS) {
            return {
                kind,
                mimeType,
                textContent: formatAttachmentNotInlined(
                    'the PDF exceeds the inline transport limit',
                    attachment.originPath
                ),
            };
        }
        return {
            kind,
            mimeType: base64.mimeType,
            base64Data: base64.data,
        };
    }

    if (kind === 'directory') {
        return {
            kind,
            mimeType,
            textContent: `[Directory]\npath: ${attachment.originPath}`,
            inlineText: true,
        };
    }

    const text = await readAttachmentAsText(attachment, {
        maxBytes: MAX_INLINE_TEXT_READ_BYTES,
        signal: options.signal,
    });
    if (text.isBinary) {
        return {
            kind: 'binary',
            mimeType,
            textContent: formatAttachmentNotInlined(
                'binary content',
                attachment.originPath,
                'Bash'
            ),
        };
    }

    return {
        kind,
        mimeType,
        textContent: text.content,
        inlineText: true,
    };
}

function pushNotInlinedText(
    parts: AiContentPart[],
    inspection: AttachmentInspection,
    text: string,
    options: { includeAnchorText?: boolean }
): void {
    if (options.includeAnchorText ?? true) {
        parts.push({
            type: 'text',
            text: formatAttachmentAnchorText(inspection.meta),
        });
    }
    parts.push({ type: 'text', text });
}

function pushMaterializedPart(
    parts: AiContentPart[],
    inspection: AttachmentInspection,
    payload: AttachmentPreparedPayload,
    budget: AttachmentPayloadBudget,
    options: { includeAnchorText?: boolean }
): void {
    const includeAnchorText = options.includeAnchorText ?? true;

    if (payload.kind === 'image') {
        if (payload.base64Data === undefined) {
            pushNotInlinedText(
                parts,
                inspection,
                payload.textContent ??
                    formatAttachmentNotInlined(
                        'the image is not available inline',
                        inspection.attachment.originPath
                    ),
                { includeAnchorText }
            );
            return;
        }
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
            data: payload.base64Data,
            kind: 'image',
            semanticIntent: inspection.semanticIntent,
            meta: inspection.meta,
        });
        return;
    }

    if (payload.kind === 'pdf' && payload.base64Data !== undefined) {
        if (payload.base64Data.length > budget.pdfBase64Chars) {
            pushNotInlinedText(
                parts,
                inspection,
                formatAttachmentNotInlined(
                    'the PDF budget for this message is exhausted',
                    inspection.attachment.originPath
                ),
                { includeAnchorText }
            );
            return;
        }
        budget.pdfBase64Chars -= payload.base64Data.length;
    }

    let textContent = payload.textContent;
    if (payload.inlineText && textContent !== undefined) {
        const perFile = Math.min(textContent.length, MAX_INLINE_TEXT_CHARS);
        const take = Math.min(perFile, Math.max(0, budget.textChars));
        if (take <= 0) {
            pushNotInlinedText(
                parts,
                inspection,
                formatAttachmentNotInlined(
                    'the text budget for this message is exhausted',
                    inspection.attachment.originPath
                ),
                { includeAnchorText }
            );
            return;
        }
        textContent = textContent.slice(0, take);
        if (take < payload.textContent!.length) {
            textContent += truncationNotice(take, inspection.attachment.originPath);
        }
        budget.textChars -= take;
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
        textContent,
        base64Data: payload.base64Data,
        meta: inspection.meta,
    });
}

export async function materializeAttachmentParts(
    inspections: AttachmentInspection[],
    options: AttachmentMaterializeOptions = {}
): Promise<AiContentPart[]> {
    options.signal?.throwIfAborted();
    const parts: AiContentPart[] = [];
    const payloadBySource = new Map<string, AttachmentPreparedPayload | null>();
    const budget: AttachmentPayloadBudget = {
        textChars: MAX_INLINE_TEXT_TOTAL_CHARS,
        pdfBase64Chars: MAX_INLINE_PDF_TOTAL_BASE64_CHARS,
    };

    for (const inspection of inspections) {
        options.signal?.throwIfAborted();
        const sourceKey = JSON.stringify([
            inspection.attachment.path,
            inspection.kind,
            inspection.mimeType,
        ]);
        if (!payloadBySource.has(sourceKey)) {
            try {
                payloadBySource.set(
                    sourceKey,
                    await awaitAbortable(
                        () => prepareAttachmentPayload(inspection, options),
                        options.signal
                    )
                );
            } catch (error) {
                options.signal?.throwIfAborted();
                options.diagnostics?.error(
                    '[AttachmentMaterialize] Failed to read attachment:',
                    error
                );
                payloadBySource.set(sourceKey, null);
            }
        }
        const payload = payloadBySource.get(sourceKey);
        if (payload) pushMaterializedPart(parts, inspection, payload, budget, options);
    }

    return parts;
}

export async function buildAttachmentParts(
    attachments: AttachmentIndex[],
    options: AttachmentMaterializeOptions = {}
): Promise<AiContentPart[]> {
    options.signal?.throwIfAborted();
    const usableAttachments = attachments.filter((attachment) => isAttachmentSupported(attachment));
    const inspections = await awaitAbortable(
        () => inspectAttachments(usableAttachments, options.signal),
        options.signal
    );

    return materializeAttachmentParts(inspections, options);
}
