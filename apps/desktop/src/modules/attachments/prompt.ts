import type { AttachmentPromptMeta } from './contracts';
import type { AttachmentIndex } from './types';

export function formatAttachmentNotInlined(
    reason: string,
    path: string,
    tool: 'Read' | 'Bash' = 'Read'
): string {
    return `[Not inlined: ${reason}. Local path: ${path}. Use the ${tool} tool with this path when the content is needed.]`;
}

export function buildAttachmentAlias(order: number): string {
    return `A${order + 1}`;
}

export function buildAttachmentPromptMetas(attachments: AttachmentIndex[]): AttachmentPromptMeta[] {
    return attachments.map((attachment, order) => ({
        alias: buildAttachmentAlias(order),
        order,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType ?? null,
        originPath: attachment.originPath,
        attachmentId: attachment.attachmentId ?? null,
        hash: attachment.hash ?? null,
    }));
}

export function formatAttachmentAnchorText(meta: AttachmentPromptMeta): string {
    const lines = [
        `[Attachment ${meta.alias}]`,
        `name: ${meta.name}`,
        `type: ${meta.type}`,
        `origin_path: ${meta.originPath}`,
        `mime_type: ${meta.mimeType ?? 'unknown'}`,
    ];
    if (meta.type === 'image') {
        lines.push(
            'inline_copy_note: the inline image may be downscaled; use origin_path when full resolution is needed.'
        );
    }
    return lines.join('\n');
}
