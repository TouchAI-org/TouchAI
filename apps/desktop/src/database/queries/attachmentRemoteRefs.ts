// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { AttachmentRemoteRefCreateData, AttachmentRemoteRefEntity } from '../types';

export async function findAttachmentRemoteRef(options: {
    attachmentId: number;
    providerId: number;
    transportKind: string;
}): Promise<AttachmentRemoteRefEntity | null> {
    return native.database.operation<AttachmentRemoteRefEntity | null>({
        kind: 'attachment_remote_ref_find',
        attachmentId: options.attachmentId,
        providerId: options.providerId,
        transportKind: options.transportKind,
    });
}

export async function upsertAttachmentRemoteRef(
    data: AttachmentRemoteRefCreateData
): Promise<AttachmentRemoteRefEntity> {
    return native.database.operation<AttachmentRemoteRefEntity>({
        kind: 'attachment_remote_ref_upsert',
        data: { ...data },
    });
}

export async function touchAttachmentRemoteRefLastUsed(options: {
    id: number;
    lastUsedAt?: string;
}): Promise<void> {
    await native.database.operation({
        kind: 'attachment_remote_ref_touch',
        id: options.id,
        lastUsedAt: options.lastUsedAt,
    });
}
