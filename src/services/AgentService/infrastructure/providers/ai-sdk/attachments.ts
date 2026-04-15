// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    findAttachmentRemoteRef,
    touchAttachmentRemoteRefLastUsed,
    upsertAttachmentRemoteRef,
} from '@database/queries';
import type { ProviderDriver } from '@database/schema';

import type {
    AiContentPart,
    AttachmentTransportDecision,
} from '@/services/AgentService/contracts/protocol';
import { base64ToUint8Array } from '@/services/AgentService/infrastructure/attachments';

import { getProviderAttachmentCapabilities } from '../capabilities';
import type { ProviderApiTargets, ProviderAttachmentFileRefStrategy } from '../types';

type AttachmentCarrierPart = Extract<AiContentPart, { type: 'image' | 'file' }>;

export interface ProviderAttachmentRequestContext {
    driver: ProviderDriver;
    providerId?: number;
    modelId: string;
    apiTargets: ProviderApiTargets;
    apiKey?: string;
    customHeaders: Record<string, string>;
    fetch: typeof fetch;
}

export interface ProviderAttachmentRemoteRef {
    strategy: Exclude<ProviderAttachmentFileRefStrategy, 'none'>;
    value: string;
}

interface UploadedAttachmentRemoteRef {
    remoteRef: string;
    expiresAt: string | null;
}

class AttachmentRemoteRefUploadError extends Error {
    constructor(
        message: string,
        readonly statusCode?: number
    ) {
        super(message);
        this.name = 'AttachmentRemoteRefUploadError';
    }
}

const permanentlyDisabledProviderFileRefUploads = new Set<string>();
const loggedProviderFileRefFallbacks = new Set<string>();

function isAttachmentRemoteRefExpired(expiresAt: string | null | undefined): boolean {
    if (!expiresAt) {
        return false;
    }

    const timestamp = Date.parse(expiresAt);
    return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function buildProviderFileRefAvailabilityKey(context: ProviderAttachmentRequestContext): string {
    return context.providerId
        ? `provider:${context.providerId}`
        : `${context.driver}:${context.apiTargets.sdkBaseUrl}`;
}

function isProviderFileRefUploadDisabled(context: ProviderAttachmentRequestContext): boolean {
    return permanentlyDisabledProviderFileRefUploads.has(
        buildProviderFileRefAvailabilityKey(context)
    );
}

function disableProviderFileRefUpload(context: ProviderAttachmentRequestContext): void {
    permanentlyDisabledProviderFileRefUploads.add(buildProviderFileRefAvailabilityKey(context));
}

function shouldPermanentlyDisableProviderFileRefUpload(error: unknown): boolean {
    if (error instanceof AttachmentRemoteRefUploadError) {
        return [400, 401, 403, 404, 405, 415, 422, 501].includes(error.statusCode ?? 0);
    }

    const message =
        error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();

    return (
        message.includes('forbidden') ||
        message.includes('unauthorized') ||
        message.includes('not allowed') ||
        message.includes('not supported') ||
        message.includes('unsupported') ||
        message.includes('not implemented')
    );
}

function summarizeProviderFileRefError(error: unknown): {
    statusCode: number | null;
    message: string;
} {
    if (error instanceof AttachmentRemoteRefUploadError) {
        return {
            statusCode: error.statusCode ?? null,
            message: error.message,
        };
    }

    if (error instanceof Error) {
        return {
            statusCode: null,
            message: error.message,
        };
    }

    return {
        statusCode: null,
        message: String(error ?? 'Unknown error'),
    };
}

function logProviderFileRefFallback(
    part: AttachmentCarrierPart,
    context: ProviderAttachmentRequestContext,
    error: unknown,
    disabled: boolean
): void {
    const errorSummary = summarizeProviderFileRefError(error);
    const logKey = `${buildProviderFileRefAvailabilityKey(context)}:${disabled ? 'disabled' : 'fallback'}`;
    if (loggedProviderFileRefFallbacks.has(logKey)) {
        return;
    }

    loggedProviderFileRefFallbacks.add(logKey);
    console.info(
        '[AiSdkAttachments] Provider file ref unavailable, falling back to inline transport.',
        {
            driver: context.driver,
            providerId: context.providerId ?? null,
            modelId: context.modelId,
            attachmentName: part.name,
            statusCode: errorSummary.statusCode,
            reason: errorSummary.message,
            uploadsDisabledForProvider: disabled,
        }
    );
}

function buildAttachmentBlob(part: AttachmentCarrierPart): Blob {
    if (part.type === 'image') {
        return new Blob([base64ToUint8Array(part.data)], { type: part.mimeType });
    }

    if (part.base64Data) {
        return new Blob([base64ToUint8Array(part.base64Data)], { type: part.mimeType });
    }

    if (part.textContent !== undefined) {
        return new Blob([part.textContent], { type: part.mimeType });
    }

    throw new Error(`Attachment part has no uploadable payload: ${part.name}`);
}

async function uploadOpenAiAttachment(
    part: AttachmentCarrierPart,
    context: ProviderAttachmentRequestContext
): Promise<UploadedAttachmentRemoteRef> {
    const formData = new FormData();
    formData.append('purpose', 'user_data');
    formData.append('file', buildAttachmentBlob(part), part.name);

    const response = await context.fetch(`${context.apiTargets.sdkBaseUrl}/files`, {
        method: 'POST',
        headers: {
            ...(context.apiKey
                ? {
                      Authorization: `Bearer ${context.apiKey}`,
                  }
                : {}),
            ...context.customHeaders,
        },
        body: formData,
    });

    if (!response.ok) {
        throw new AttachmentRemoteRefUploadError(
            `OpenAI file upload failed: ${response.status} ${response.statusText}`,
            response.status
        );
    }

    const payload = (await response.json()) as { id?: string };
    if (!payload.id) {
        throw new AttachmentRemoteRefUploadError('OpenAI file upload returned no file id');
    }

    return {
        remoteRef: payload.id,
        expiresAt: null,
    };
}

function getGoogleUploadBaseUrl(apiTargets: ProviderApiTargets): string {
    return apiTargets.sdkBaseUrl.replace(/\/v1beta$/, '/upload/v1beta');
}

function extractGoogleFileRecord(payload: unknown): {
    name?: string;
    uri?: string;
    state?: string;
    expirationTime?: string;
} | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const record = payload as Record<string, unknown>;
    const file =
        record.file && typeof record.file === 'object'
            ? (record.file as Record<string, unknown>)
            : record;

    return {
        name: typeof file.name === 'string' ? file.name : undefined,
        uri: typeof file.uri === 'string' ? file.uri : undefined,
        state:
            typeof file.state === 'string'
                ? file.state
                : file.state && typeof file.state === 'object' && 'name' in file.state
                  ? String((file.state as Record<string, unknown>).name ?? '')
                  : undefined,
        expirationTime: typeof file.expirationTime === 'string' ? file.expirationTime : undefined,
    };
}

async function waitForGoogleFileActive(
    file: ReturnType<typeof extractGoogleFileRecord>,
    context: ProviderAttachmentRequestContext
): Promise<UploadedAttachmentRemoteRef> {
    if (!file || !file.name) {
        throw new AttachmentRemoteRefUploadError('Google file upload returned no file name');
    }

    let current = file;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (current?.uri && (!current.state || current.state === 'ACTIVE')) {
            return {
                remoteRef: current.uri,
                expiresAt: current.expirationTime ?? null,
            };
        }

        if (current?.state === 'FAILED') {
            throw new AttachmentRemoteRefUploadError('Google file processing failed');
        }

        await new Promise((resolve) => setTimeout(resolve, 500));

        const response = await context.fetch(`${context.apiTargets.sdkBaseUrl}/${current.name}`, {
            method: 'GET',
            headers: {
                ...(context.apiKey
                    ? {
                          'x-goog-api-key': context.apiKey,
                      }
                    : {}),
                ...context.customHeaders,
            },
        });
        if (!response.ok) {
            throw new AttachmentRemoteRefUploadError(
                `Google file status lookup failed: ${response.status} ${response.statusText}`,
                response.status
            );
        }
        const next = extractGoogleFileRecord(await response.json());
        if (!next) {
            throw new AttachmentRemoteRefUploadError(
                'Google file status lookup returned invalid payload'
            );
        }
        current = next;
    }

    throw new AttachmentRemoteRefUploadError('Google file did not become ACTIVE in time');
}

async function uploadGoogleAttachment(
    part: AttachmentCarrierPart,
    context: ProviderAttachmentRequestContext
): Promise<UploadedAttachmentRemoteRef> {
    const blob = buildAttachmentBlob(part);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const startResponse = await context.fetch(
        `${getGoogleUploadBaseUrl(context.apiTargets)}/files`,
        {
            method: 'POST',
            headers: {
                ...(context.apiKey
                    ? {
                          'x-goog-api-key': context.apiKey,
                      }
                    : {}),
                ...context.customHeaders,
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
                'X-Goog-Upload-Header-Content-Type': part.mimeType,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                file: {
                    display_name: part.name,
                },
            }),
        }
    );

    if (!startResponse.ok) {
        throw new AttachmentRemoteRefUploadError(
            `Google file upload init failed: ${startResponse.status} ${startResponse.statusText}`,
            startResponse.status
        );
    }

    const uploadUrl =
        startResponse.headers.get('x-goog-upload-url') ??
        startResponse.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) {
        throw new AttachmentRemoteRefUploadError('Google file upload init returned no upload URL');
    }

    const uploadResponse = await context.fetch(uploadUrl, {
        method: 'POST',
        headers: {
            ...(context.apiKey
                ? {
                      'x-goog-api-key': context.apiKey,
                  }
                : {}),
            ...context.customHeaders,
            'Content-Type': part.mimeType,
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: bytes,
    });

    if (!uploadResponse.ok) {
        throw new AttachmentRemoteRefUploadError(
            `Google file upload finalize failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
            uploadResponse.status
        );
    }

    return waitForGoogleFileActive(extractGoogleFileRecord(await uploadResponse.json()), context);
}

async function uploadAttachmentRemoteRef(
    part: AttachmentCarrierPart,
    context: ProviderAttachmentRequestContext
): Promise<UploadedAttachmentRemoteRef | null> {
    switch (context.driver) {
        case 'openai':
            return uploadOpenAiAttachment(part, context);
        case 'google':
            return uploadGoogleAttachment(part, context);
        default:
            return null;
    }
}

async function findReusableAttachmentRemoteRef(
    part: AttachmentCarrierPart,
    context: ProviderAttachmentRequestContext
): Promise<ProviderAttachmentRemoteRef | null> {
    const capabilities = getProviderAttachmentCapabilities(context.driver);
    if (
        !capabilities.supportsProviderFileRef ||
        capabilities.fileRefStrategy === 'none' ||
        !context.providerId ||
        !part.meta.attachmentId
    ) {
        return null;
    }

    const existing = await findAttachmentRemoteRef({
        attachmentId: part.meta.attachmentId,
        providerId: context.providerId,
        transportKind: capabilities.remoteRefTransportMode,
    });
    if (!existing || isAttachmentRemoteRefExpired(existing.expires_at)) {
        return null;
    }

    await touchAttachmentRemoteRefLastUsed({ id: existing.id }).catch((error) => {
        console.error('[AiSdkAttachments] Failed to touch attachment remote ref:', error);
    });

    return {
        strategy: capabilities.fileRefStrategy,
        value: existing.remote_ref,
    };
}

export async function resolveProviderAttachmentRemoteRef(
    part: AttachmentCarrierPart,
    decision: AttachmentTransportDecision,
    context: ProviderAttachmentRequestContext
): Promise<ProviderAttachmentRemoteRef | null> {
    const capabilities = getProviderAttachmentCapabilities(context.driver);
    if (!decision.canReuseRemoteRef && !decision.shouldUpload) {
        return null;
    }

    const reusableRemoteRef = decision.canReuseRemoteRef
        ? await findReusableAttachmentRemoteRef(part, context)
        : null;
    if (reusableRemoteRef) {
        return reusableRemoteRef;
    }

    if (isProviderFileRefUploadDisabled(context)) {
        return null;
    }

    if (
        !decision.shouldUpload ||
        !capabilities.supportsProviderFileRef ||
        capabilities.fileRefStrategy === 'none' ||
        !context.providerId ||
        !part.meta.attachmentId
    ) {
        return null;
    }

    let uploaded: UploadedAttachmentRemoteRef | null;
    try {
        uploaded = await uploadAttachmentRemoteRef(part, context);
    } catch (error) {
        const shouldDisable = shouldPermanentlyDisableProviderFileRefUpload(error);
        if (shouldDisable) {
            disableProviderFileRefUpload(context);
        }
        logProviderFileRefFallback(part, context, error, shouldDisable);
        return null;
    }

    if (!uploaded) {
        return null;
    }

    await upsertAttachmentRemoteRef({
        attachment_id: part.meta.attachmentId,
        provider_id: context.providerId,
        transport_kind: capabilities.remoteRefTransportMode,
        remote_ref: uploaded.remoteRef,
        mime_type: part.mimeType,
        expires_at: uploaded.expiresAt,
    });

    return {
        strategy: capabilities.fileRefStrategy,
        value: uploaded.remoteRef,
    };
}
