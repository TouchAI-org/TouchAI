import type { AttachmentRemoteRefEntity } from '@database/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    findAttachmentRemoteRef,
    touchAttachmentRemoteRefLastUsed,
    upsertAttachmentRemoteRef,
} from '@/database/queries/attachmentRemoteRefs';

const mocks = vi.hoisted(() => ({
    operation: vi.fn(),
}));

vi.mock('@services/NativeService', () => ({
    native: { database: { operation: mocks.operation } },
}));

const remoteRef: AttachmentRemoteRefEntity = {
    id: 8,
    attachment_id: 3,
    provider_id: 5,
    transport_kind: 'openai-file-id',
    remote_ref: 'file-abc',
    mime_type: 'application/pdf',
    expires_at: null,
    last_used_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
};

describe('user reuses a provider attachment reference', () => {
    beforeEach(() => {
        mocks.operation.mockReset();
    });

    it('user gets the stored reference for the attachment provider and transport', async () => {
        mocks.operation.mockResolvedValue(remoteRef);

        await expect(
            findAttachmentRemoteRef({
                attachmentId: 3,
                providerId: 5,
                transportKind: 'openai-file-id',
            })
        ).resolves.toBe(remoteRef);
        expect(mocks.operation).toHaveBeenCalledExactlyOnceWith({
            kind: 'attachment_remote_ref_find',
            attachmentId: 3,
            providerId: 5,
            transportKind: 'openai-file-id',
        });
    });

    it('user gets the upserted reference returned by the native database', async () => {
        mocks.operation.mockResolvedValue(remoteRef);
        const data = {
            attachment_id: 3,
            provider_id: 5,
            transport_kind: 'openai-file-id',
            remote_ref: 'file-abc',
            mime_type: 'application/pdf',
            expires_at: null,
        };

        await expect(upsertAttachmentRemoteRef(data)).resolves.toBe(remoteRef);
        expect(mocks.operation).toHaveBeenCalledExactlyOnceWith({
            kind: 'attachment_remote_ref_upsert',
            data,
        });
    });

    it('user records when a reusable reference was last used', async () => {
        mocks.operation.mockResolvedValue(null);

        await touchAttachmentRemoteRefLastUsed({
            id: 8,
            lastUsedAt: '2026-02-01T00:00:00.000Z',
        });

        expect(mocks.operation).toHaveBeenCalledExactlyOnceWith({
            kind: 'attachment_remote_ref_touch',
            id: 8,
            lastUsedAt: '2026-02-01T00:00:00.000Z',
        });
    });
});
