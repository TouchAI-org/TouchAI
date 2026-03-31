/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import type { AttachmentSupportStatus, Index } from './types';

/**
 * 根据文件类型和模型能力计算附件支持状态。
 *
 * @param fileType 附件类型（'image' | 'file'）。
 * @param capabilities 当前模型的能力标志。
 * @returns 'supported' | 'unsupported-image' | 'unsupported-file'。
 */
export function resolveAttachmentSupportStatus(
    fileType: 'image' | 'file',
    capabilities: { supportsImages: boolean; supportsFiles: boolean }
): AttachmentSupportStatus {
    if (fileType === 'image' && !capabilities.supportsImages) return 'unsupported-image';
    if (fileType === 'file' && !capabilities.supportsFiles) return 'unsupported-file';
    return 'supported';
}

export function isAttachmentSupported(attachment: Index): boolean {
    return (
        attachment.supportStatus !== 'unsupported-image' &&
        attachment.supportStatus !== 'unsupported-file'
    );
}

export function getAttachmentSupportMessage(attachment: Index): string | null {
    if (attachment.supportStatus === 'unsupported-image') {
        return '该模型不支持图片';
    }
    if (attachment.supportStatus === 'unsupported-file') {
        return '该模型不支持文件';
    }
    return null;
}
