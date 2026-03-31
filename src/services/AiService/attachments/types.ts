/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

export type AttachmentSupportStatus = 'supported' | 'unsupported-image' | 'unsupported-file';

export interface Index {
    id: string;
    attachmentId?: number;
    hash?: string;
    type: 'image' | 'file';
    path: string;
    name: string;
    size?: number;
    preview?: string;
    mimeType?: string;
    supportStatus?: AttachmentSupportStatus;
}
