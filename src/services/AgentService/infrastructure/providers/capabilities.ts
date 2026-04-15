// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import type { ProviderAttachmentCapabilities } from './types';

const DEFAULT_MAX_INLINE_REQUEST_BYTES = 1024 * 1024;

const providerAttachmentCapabilitiesByDriver: Record<
    ProviderDriver,
    ProviderAttachmentCapabilities
> = {
    openai: {
        supportsImageInput: true,
        supportsDocumentInput: true,
        supportsExternalUrl: false,
        supportsProviderFileRef: true,
        supportsMediaInToolResults: false,
        prefersFileRefForPdf: true,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'openai-file-id',
        remoteRefTransportMode: 'provider-file-ref',
    },
    anthropic: {
        supportsImageInput: true,
        supportsDocumentInput: true,
        supportsExternalUrl: true,
        // 当前仓库锁定的 AI SDK 版本尚未把 Anthropic Files API file_id 接入 prompt 映射。
        supportsProviderFileRef: false,
        supportsMediaInToolResults: true,
        prefersFileRefForPdf: false,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'none',
        remoteRefTransportMode: 'provider-file-ref',
    },
    google: {
        supportsImageInput: true,
        supportsDocumentInput: true,
        supportsExternalUrl: true,
        supportsProviderFileRef: true,
        supportsMediaInToolResults: true,
        prefersFileRefForPdf: true,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'url',
        remoteRefTransportMode: 'provider-file-ref',
    },
    deepseek: {
        supportsImageInput: true,
        supportsDocumentInput: false,
        supportsExternalUrl: false,
        supportsProviderFileRef: false,
        supportsMediaInToolResults: false,
        prefersFileRefForPdf: false,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'none',
        remoteRefTransportMode: 'provider-file-ref',
    },
    xai: {
        supportsImageInput: true,
        supportsDocumentInput: false,
        supportsExternalUrl: true,
        supportsProviderFileRef: false,
        supportsMediaInToolResults: false,
        prefersFileRefForPdf: false,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'none',
        remoteRefTransportMode: 'provider-file-ref',
    },
    moonshot: {
        supportsImageInput: true,
        supportsDocumentInput: false,
        supportsExternalUrl: false,
        supportsProviderFileRef: false,
        supportsMediaInToolResults: false,
        prefersFileRefForPdf: false,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'none',
        remoteRefTransportMode: 'provider-file-ref',
    },
    alibaba: {
        supportsImageInput: true,
        supportsDocumentInput: false,
        supportsExternalUrl: false,
        supportsProviderFileRef: false,
        supportsMediaInToolResults: false,
        prefersFileRefForPdf: false,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'none',
        remoteRefTransportMode: 'provider-file-ref',
    },
    minimax: {
        supportsImageInput: true,
        supportsDocumentInput: false,
        supportsExternalUrl: false,
        supportsProviderFileRef: false,
        supportsMediaInToolResults: false,
        prefersFileRefForPdf: false,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'none',
        remoteRefTransportMode: 'provider-file-ref',
    },
    zhipu: {
        supportsImageInput: true,
        supportsDocumentInput: false,
        supportsExternalUrl: false,
        supportsProviderFileRef: false,
        supportsMediaInToolResults: false,
        prefersFileRefForPdf: false,
        maxInlineRequestBytes: DEFAULT_MAX_INLINE_REQUEST_BYTES,
        fileRefStrategy: 'none',
        remoteRefTransportMode: 'provider-file-ref',
    },
};

export function getProviderAttachmentCapabilities(
    driver: ProviderDriver
): ProviderAttachmentCapabilities {
    return providerAttachmentCapabilitiesByDriver[driver];
}
