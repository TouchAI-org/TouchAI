import type { JsonObject, ProviderDriver } from '@touchai/models/contracts';

export type AttachmentTransportMode =
    | 'inline-image'
    | 'inline-text'
    | 'inline-base64'
    | 'provider-file-ref'
    | 'external-url';

export type AttachmentDerivedKind =
    | 'image'
    | 'pdf'
    | 'text'
    | 'code'
    | 'structured-text'
    | 'binary'
    | 'directory';

export type AttachmentSemanticIntent =
    | 'visual-reference'
    | 'document-content'
    | 'textual-content'
    | 'binary-content'
    | 'directory-reference';

export type AttachmentMessagePositionMode = 'inline' | 'synthetic-user-hoist';

export interface AttachmentTransportDecision {
    kind: AttachmentDerivedKind;
    transportMode: AttachmentTransportMode;
    reason: string;
    shouldUpload: boolean;
    canReuseRemoteRef: boolean;
    messagePositionMode: AttachmentMessagePositionMode;
}

export interface AttachmentPromptMeta {
    alias: string;
    order: number;
    type: 'image' | 'file';
    name: string;
    mimeType: string | null;
    originPath: string;
    attachmentId: number | null;
    hash: string | null;
}

export interface AttachmentDeliveryManifestEntry {
    messageIndex: number;
    partIndex: number;
    sourceRole: 'user' | 'tool';
    resolvedRole: 'user' | 'tool';
    messageContext: 'user' | 'tool-result';
    toolCallId?: string;
    toolName?: string;
    alias: string;
    order: number;
    type: 'image' | 'file';
    name: string;
    size: number | null;
    mimeType: string;
    originPath: string;
    sourcePath: string;
    attachmentId: number | null;
    hash: string | null;
    derivedKind: AttachmentDerivedKind;
    semanticIntent: AttachmentSemanticIntent;
    transportMode: AttachmentTransportMode;
    messagePositionMode: AttachmentMessagePositionMode;
    transportReason: string;
    remoteRefStrategy?: string | null;
}

export interface AttachmentDeliveryManifestRequest {
    requestIndex: number;
    providerDriver: ProviderDriver;
    providerId: number | null;
    modelId: string;
    createdAt: string;
    entries: AttachmentDeliveryManifestEntry[];
}

export interface AttachmentDeliveryManifest {
    version: 1;
    requests: AttachmentDeliveryManifestRequest[];
}

/**
 * 单条消息内容在应用内部的统一片段表示。
 */
export type AttachmentContentPart =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string; providerOptions?: Record<string, JsonObject> }
    | {
          type: 'image';
          name: string;
          sourcePath: string;
          size: number | null;
          mimeType: string;
          data: string;
          kind: 'image';
          semanticIntent: AttachmentSemanticIntent;
          meta: AttachmentPromptMeta;
      }
    | {
          type: 'file';
          name: string;
          sourcePath: string;
          size: number | null;
          mimeType: string;
          kind: Exclude<AttachmentDerivedKind, 'image'>;
          semanticIntent: AttachmentSemanticIntent;
          textContent?: string;
          base64Data?: string;
          meta: AttachmentPromptMeta;
      }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface AttachmentMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | AttachmentContentPart[];
    tool_call_id?: string;
    name?: string;
}
