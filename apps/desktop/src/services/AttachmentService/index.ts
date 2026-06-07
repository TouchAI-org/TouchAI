/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

export {
    createAttachment,
    createPersistedAttachmentFromData,
    ensurePersistedAttachmentIndex,
    hydratePersistedAttachments,
} from './storage';
export {
    type AttachmentCapabilities,
    type AttachmentType,
    getAttachmentSupportMessage,
    getModelAttachmentCapabilities,
    getUnsupportedAttachmentTypes,
    isAttachmentSupported,
    resolveAttachmentSupportStatus,
} from './support';
export type {
    AttachmentIndex,
    AttachmentSupportStatus,
    AttachmentIndex as Index,
} from '@/contracts/attachments';
