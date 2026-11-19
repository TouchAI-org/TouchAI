// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getProviderAttachmentCapabilities } from '../catalog/capabilities';
import type { ModelsHost } from '../contracts/host';
import type { AiContentPart, MediaTransportDecision } from '../contracts/message';
import type { ProviderDriver } from '../contracts/model';
import type { ProviderApiTargets, ProviderAttachmentFileRefStrategy } from '../contracts/model';
import { base64ToUint8Array, bytesToArrayBuffer } from '../encoding/attachments';

type AttachmentCarrierPart = Extract<AiContentPart, { type: 'image' | 'file' }>;

export interface ProviderAttachmentRequestContext {
    driver: ProviderDriver;
    signal: AbortSignal;
    modelId: string;
    apiTargets: ProviderApiTargets;
    apiKey?: string;
    customHeaders: Record<string, string>;
    fetch: typeof fetch;
    host: ModelsHost;
    uploadState: ProviderUploadState;
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

export interface ProviderUploadState {
    disabled: boolean;
    loggedDisabled: boolean;
    loggedFallback: boolean;
}

export function createProviderUploadState(): ProviderUploadState {
    return { disabled: false, loggedDisabled: false, loggedFallback: false };
}

function isAttachmentRemoteRefExpired(expiresAt: string | null | undefined): boolean {
    if (!expiresAt) {
        return false;
    }

    const timestamp = Date.parse(expiresAt);
    return Number.isFinite(timestamp) && timestamp <= Date.now();
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

function logProviderFileRefFallback(
    context: ProviderAttachmentRequestContext,
    error: unknown,
    disabled: boolean
): void {
    const logKey = disabled ? 'loggedDisabled' : 'loggedFallback';
    if (context.uploadState[logKey]) {
        return;
    }

    context.uploadState[logKey] = true;
    context.host.diagnostics?.({
        kind: 'upload-fallback',
        driver: context.driver,
        statusCode:
            error instanceof AttachmentRemoteRefUploadError ? (error.statusCode ?? null) : null,
        disabled,
    });
}

function buildAttachmentBlob(part: AttachmentCarrierPart): Blob {
    if (part.type === 'image') {
        return new Blob([bytesToArrayBuffer(base64ToUint8Array(part.data))], {
            type: part.mimeType,
        });
    }

    if (part.base64Data) {
        return new Blob([bytesToArrayBuffer(base64ToUint8Array(part.base64Data))], {
            type: part.mimeType,
        });
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
        signal: context.signal,
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

function waitForProcessing(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, 500);
        signal.addEventListener('abort', onAbort, { once: true });
    });
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

        await waitForProcessing(context.signal);

        const response = await context.fetch(`${context.apiTargets.sdkBaseUrl}/${current.name}`, {
            signal: context.signal,
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
            signal: context.signal,
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
        signal: context.signal,
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
        !part.resourceKey
    ) {
        return null;
    }

    context.signal.throwIfAborted();
    const existing = await context.host.remoteRefs.read(part.resourceKey);
    context.signal.throwIfAborted();
    if (!existing || isAttachmentRemoteRefExpired(existing.expiresAt)) {
        return null;
    }

    await context.host.remoteRefs.touch(part.resourceKey).catch(() => {
        context.host.diagnostics?.({ kind: 'remote-ref-touch-failed', driver: context.driver });
    });

    return {
        strategy: capabilities.fileRefStrategy,
        value: existing.ref,
    };
}

export async function resolveProviderAttachmentRemoteRef(
    part: AttachmentCarrierPart,
    decision: MediaTransportDecision,
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

    if (context.uploadState.disabled) {
        return null;
    }

    if (
        !decision.shouldUpload ||
        !capabilities.supportsProviderFileRef ||
        capabilities.fileRefStrategy === 'none' ||
        !part.resourceKey
    ) {
        return null;
    }

    let uploaded: UploadedAttachmentRemoteRef | null;
    try {
        uploaded = await uploadAttachmentRemoteRef(part, context);
    } catch (error) {
        context.signal.throwIfAborted();
        const shouldDisable = shouldPermanentlyDisableProviderFileRefUpload(error);
        if (shouldDisable) {
            context.uploadState.disabled = true;
        }
        logProviderFileRefFallback(context, error, shouldDisable);
        return null;
    }

    if (!uploaded) {
        return null;
    }

    context.signal.throwIfAborted();
    await context.host.remoteRefs.write(part.resourceKey, {
        ref: uploaded.remoteRef,
        mimeType: part.mimeType,
        expiresAt: uploaded.expiresAt,
    });

    return {
        strategy: capabilities.fileRefStrategy,
        value: uploaded.remoteRef,
    };
}
