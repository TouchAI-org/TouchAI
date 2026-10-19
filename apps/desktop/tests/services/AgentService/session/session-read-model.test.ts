import type { MessageRow } from '@database/queries/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionReadModel } from '@/services/AgentService/session/readModel';
import {
    findUnsupportedSessionAttachmentTypes,
    loadSessionTransportMessages,
} from '@/services/AgentService/session/transport';

const { findMessagesMock } = vi.hoisted(() => ({ findMessagesMock: vi.fn() }));

vi.mock('@database/queries/messages', () => ({
    findMessagesBySessionId: findMessagesMock,
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
        findMessagesMock.mockReset();
        findMessagesMock.mockResolvedValue(createRows());
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

        expect(findMessagesMock).toHaveBeenCalledTimes(1);
        expect(findMessagesMock).toHaveBeenCalledWith(7);
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

        expect(findMessagesMock).toHaveBeenCalledTimes(2);
    });

    it('caches per session id and shares the in-flight promise', async () => {
        const readModel = createSessionReadModel();

        const [first, second] = await Promise.all([
            readModel.getMessages(7),
            readModel.getMessages(7),
        ]);
        expect(first).toBe(second);
        expect(findMessagesMock).toHaveBeenCalledTimes(1);

        await readModel.getMessages(8);
        expect(findMessagesMock).toHaveBeenCalledTimes(2);
    });
});
