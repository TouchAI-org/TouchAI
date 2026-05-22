/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import type {
    AttachmentDeliveryManifest,
    AttachmentDeliveryManifestRequest,
} from '../../contracts/protocol';

export function createEmptyAttachmentDeliveryManifest(): AttachmentDeliveryManifest {
    return {
        version: 1,
        requests: [],
    };
}

export function createAttachmentDeliveryManifestRequest(
    request: Omit<AttachmentDeliveryManifestRequest, 'createdAt'> & {
        createdAt?: string;
    }
): AttachmentDeliveryManifestRequest {
    return {
        ...request,
        createdAt: request.createdAt ?? new Date().toISOString(),
    };
}

export function upsertAttachmentDeliveryManifestRequest(
    manifest: AttachmentDeliveryManifest,
    request: AttachmentDeliveryManifestRequest
): AttachmentDeliveryManifest {
    const nextRequests = manifest.requests.filter(
        (currentRequest) => currentRequest.requestIndex !== request.requestIndex
    );
    nextRequests.push(request);
    nextRequests.sort((left, right) => left.requestIndex - right.requestIndex);

    return {
        version: 1,
        requests: nextRequests,
    };
}

export function serializeAttachmentDeliveryManifest(manifest: AttachmentDeliveryManifest): string {
    return JSON.stringify(manifest);
}
