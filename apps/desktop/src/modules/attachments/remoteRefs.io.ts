import { type DatabaseExecutor, db } from '@database';
import { eq } from '@database/expressions';
import {
    findAttachmentRemoteRef,
    touchAttachmentRemoteRefLastUsed,
    upsertAttachmentRemoteRef,
} from '@database/queries/attachmentRemoteRefs';
import { providers } from '@database/schema';

import type { AttachmentRemoteRefStore } from './remoteRefs';

export function createAttachmentRemoteRefStore(binding: {
    providerId?: number;
    bindingUpdatedAt: string | null;
}): AttachmentRemoteRefStore {
    const current = async (tx: DatabaseExecutor): Promise<boolean> => {
        if (binding.providerId === undefined || binding.bindingUpdatedAt === null) return false;
        const row = await tx
            .select({ enabled: providers.enabled, updatedAt: providers.updated_at })
            .from(providers)
            .where(eq(providers.id, binding.providerId))
            .get();
        return row?.enabled === 1 && row.updatedAt === binding.bindingUpdatedAt;
    };
    return {
        async read(attachmentId, providerId) {
            const record = await findAttachmentRemoteRef({
                attachmentId,
                providerId,
                transportKind: 'provider-file-ref',
            });
            return record
                ? {
                      id: record.id,
                      ref: record.remote_ref,
                      expiresAt: record.expires_at,
                      createdAt: record.updated_at ?? record.created_at,
                  }
                : null;
        },
        async touch(id) {
            await db.transaction(async (tx) => {
                if (await current(tx)) await touchAttachmentRemoteRefLastUsed({ id, database: tx });
            });
        },
        async write(attachmentId, providerId, ref) {
            await db.transaction(async (tx) => {
                if (!(await current(tx))) return;
                await upsertAttachmentRemoteRef(
                    {
                        attachment_id: attachmentId,
                        provider_id: providerId,
                        transport_kind: 'provider-file-ref',
                        remote_ref: ref.ref,
                        mime_type: ref.mimeType,
                        expires_at: ref.expiresAt,
                    },
                    tx
                );
            });
        },
    };
}
