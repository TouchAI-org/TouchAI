/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

export { buildAttachmentParts, readAttachmentAsBase64, readAttachmentAsText } from './content';
export {
    createAttachment,
    ensurePersistedAttachmentIndex,
    hydratePersistedAttachments,
} from './storage';
export {
    getAttachmentSupportMessage,
    isAttachmentSupported,
    resolveAttachmentSupportStatus,
} from './support';
export type { AttachmentIndex, AttachmentSupportStatus } from './types';
export type { AttachmentIndex as Index } from './types';
