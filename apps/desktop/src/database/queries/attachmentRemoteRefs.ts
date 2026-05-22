// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, eq } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { attachmentRemoteRefs } from '../schema';
import type { AttachmentRemoteRefCreateData, AttachmentRemoteRefEntity } from '../types';

export async function findAttachmentRemoteRef(options: {
    attachmentId: number;
    providerId: number;
    transportKind: string;
    database?: DatabaseExecutor;
}): Promise<AttachmentRemoteRefEntity | null> {
    const database = options.database ?? db;
    return (
        (await database
            .select()
            .from(attachmentRemoteRefs)
            .where(
                and(
                    eq(attachmentRemoteRefs.attachment_id, options.attachmentId),
                    eq(attachmentRemoteRefs.provider_id, options.providerId),
                    eq(attachmentRemoteRefs.transport_kind, options.transportKind)
                )
            )
            .get()) ?? null
    );
}

export async function upsertAttachmentRemoteRef(
    data: AttachmentRemoteRefCreateData,
    database: DatabaseExecutor = db
): Promise<AttachmentRemoteRefEntity> {
    const updatedAt = data.updated_at ?? new Date().toISOString();
    const createdAt = data.created_at ?? updatedAt;
    const lastUsedAt = data.last_used_at ?? updatedAt;

    const row = await database
        .insert(attachmentRemoteRefs)
        .values({
            ...data,
            created_at: createdAt,
            updated_at: updatedAt,
            last_used_at: lastUsedAt,
        })
        .onConflictDoUpdate({
            target: [
                attachmentRemoteRefs.attachment_id,
                attachmentRemoteRefs.provider_id,
                attachmentRemoteRefs.transport_kind,
            ],
            set: {
                remote_ref: data.remote_ref,
                mime_type: data.mime_type ?? null,
                expires_at: data.expires_at ?? null,
                last_used_at: lastUsedAt,
                updated_at: updatedAt,
            },
        })
        .returning()
        .get();

    if (!row || row.id === undefined) {
        throw new Error('Failed to upsert attachment remote ref');
    }

    return row;
}

export async function touchAttachmentRemoteRefLastUsed(options: {
    id: number;
    lastUsedAt?: string;
    database?: DatabaseExecutor;
}): Promise<void> {
    const database = options.database ?? db;
    const lastUsedAt = options.lastUsedAt ?? new Date().toISOString();

    await database
        .update(attachmentRemoteRefs)
        .set({
            last_used_at: lastUsedAt,
            updated_at: lastUsedAt,
        })
        .where(eq(attachmentRemoteRefs.id, options.id))
        .run();
}
