/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

export {
    base64ToUint8Array,
    bufferToBase64,
    buildAttachmentAlias,
    buildAttachmentPromptMetas,
    formatAttachmentAnchorText,
    readAttachmentAsBase64,
    readAttachmentAsText,
    readAttachmentBuffer,
} from './content';
export { type AttachmentInspection, inspectAttachment, inspectAttachments } from './inspect';
export {
    createAttachmentDeliveryManifestRequest,
    createEmptyAttachmentDeliveryManifest,
    serializeAttachmentDeliveryManifest,
    upsertAttachmentDeliveryManifestRequest,
} from './manifest';
export { buildAttachmentParts, materializeAttachmentParts } from './materialize';
export {
    type AttachmentDeliveryPlan,
    type AttachmentDeliveryPlanEntry,
    buildAttachmentTransportDecision,
    getAttachmentDeliveryPlanEntry,
    planAttachmentDeliveryForMessages,
    resolveDeliveredInlineTransportMode,
} from './planner';
export {
    createAttachment,
    createPersistedAttachmentFromData,
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
