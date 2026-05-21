/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

export type AttachmentSupportStatus = 'supported' | 'unsupported-image' | 'unsupported-file';

export interface AttachmentIndex {
    id: string;
    attachmentId?: number;
    hash?: string;
    type: 'image' | 'file';
    path: string;
    originPath: string;
    name: string;
    size?: number;
    preview?: string;
    mimeType?: string;
    supportStatus?: AttachmentSupportStatus;
    /**
     * 剪贴板 mixed payload 导入时，附件应插入到纯文本草稿的哪个字符位置。
     */
    draftInsertionOffset?: number;
}
