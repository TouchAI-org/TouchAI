import type { MessageRow } from '@database/queries/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionReadModel } from '@/services/AgentService/session/readModel';
import {
    findUnsupportedSessionAttachmentTypes,
    loadSessionTransportMessages,
} from '@/services/AgentService/session/transport';

const { loadSessionMessages } = vi.hoisted(() => ({ loadSessionMessages: vi.fn() }));

vi.mock('@services/NativeService', () => ({
    native: { database: { operation: loadSessionMessages } },
}));

const ATTACHMENT_CAPABILITIES = { supportsImages: false, supportsFiles: false };

function createRows(): MessageRow[] {
    return [
        {
            id: 1,
            session_id: 7,
            role: 'user',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            attachments: [],
            parts: [],
        },
    ] as unknown as MessageRow[];
}

describe('createSessionReadModel', () => {
    beforeEach(() => {
        loadSessionMessages.mockReset();
        loadSessionMessages.mockResolvedValue(createRows());
    });

    it('reuses one messages read across attachment precheck and transport rebuild', async () => {
        const readModel = createSessionReadModel();

        await findUnsupportedSessionAttachmentTypes({
            sessionId: 7,
            capabilities: ATTACHMENT_CAPABILITIES,
            readModel,
        });
        await loadSessionTransportMessages({
            sessionId: 7,
            attachmentCapabilities: ATTACHMENT_CAPABILITIES,
            readModel,
        });

        expect(loadSessionMessages).toHaveBeenCalledTimes(1);
        expect(loadSessionMessages).toHaveBeenCalledWith({
            kind: 'session_messages',
            sessionId: 7,
        });
    });

    it('falls back to a fresh read for each consumer without a read model', async () => {
        await findUnsupportedSessionAttachmentTypes({
            sessionId: 7,
            capabilities: ATTACHMENT_CAPABILITIES,
        });
        await loadSessionTransportMessages({
            sessionId: 7,
            attachmentCapabilities: ATTACHMENT_CAPABILITIES,
        });

        expect(loadSessionMessages).toHaveBeenCalledTimes(2);
    });

    it('caches per session id and shares the in-flight promise', async () => {
        const readModel = createSessionReadModel();

        const [first, second] = await Promise.all([
            readModel.getMessages(7),
            readModel.getMessages(7),
        ]);
        expect(first).toBe(second);
        expect(loadSessionMessages).toHaveBeenCalledTimes(1);

        await readModel.getMessages(8);
        expect(loadSessionMessages).toHaveBeenCalledTimes(2);
    });
});
