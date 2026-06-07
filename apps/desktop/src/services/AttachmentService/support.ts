/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import type { AttachmentIndex, AttachmentSupportStatus } from '@/contracts/attachments';
import { tt } from '@/i18n';
import { parseModelModalities } from '@/utils/modelSchemas';

export interface AttachmentCapabilities {
    supportsImages: boolean;
    supportsFiles: boolean;
}

export type AttachmentType = AttachmentIndex['type'];

export function getModelAttachmentCapabilities(model: {
    modalities?: string | null;
    attachment?: number | null;
}): AttachmentCapabilities {
    const modalities = parseModelModalities(model.modalities);
    return {
        supportsImages: Boolean(modalities.input?.includes('image')),
        supportsFiles: model.attachment === 1,
    };
}

export function getUnsupportedAttachmentTypes(
    attachments: Pick<AttachmentIndex, 'type'>[],
    capabilities: AttachmentCapabilities
): AttachmentType[] {
    const unsupportedTypes = new Set<AttachmentType>();

    for (const attachment of attachments) {
        if (attachment.type === 'image' && !capabilities.supportsImages) {
            unsupportedTypes.add('image');
        }
        if (attachment.type === 'file' && !capabilities.supportsFiles) {
            unsupportedTypes.add('file');
        }
    }

    return Array.from(unsupportedTypes);
}

/**
 * 根据文件类型和模型能力计算附件支持状态。
 *
 * @param fileType 附件类型（'image' | 'file'）。
 * @param capabilities 当前模型的能力标志。
 * @returns 'supported' | 'unsupported-image' | 'unsupported-file'。
 */
export function resolveAttachmentSupportStatus(
    fileType: 'image' | 'file',
    capabilities: AttachmentCapabilities
): AttachmentSupportStatus {
    if (fileType === 'image' && !capabilities.supportsImages) return 'unsupported-image';
    if (fileType === 'file' && !capabilities.supportsFiles) return 'unsupported-file';
    return 'supported';
}

export function isAttachmentSupported(attachment: AttachmentIndex): boolean {
    return (
        attachment.supportStatus !== 'unsupported-image' &&
        attachment.supportStatus !== 'unsupported-file'
    );
}

export function getAttachmentSupportMessage(attachment: AttachmentIndex): string | null {
    if (attachment.supportStatus === 'unsupported-image') {
        return tt('该模型不支持图片');
    }
    if (attachment.supportStatus === 'unsupported-file') {
        return tt('该模型不支持文件');
    }
    return null;
}
