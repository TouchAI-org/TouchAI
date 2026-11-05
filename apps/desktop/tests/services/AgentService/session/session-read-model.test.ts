import type { MessageRow } from '@database/queries/messages';
import type { MessagePartEntity } from '@database/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionReadModel } from '@/services/AgentService/session/readModel';
import {
    findUnsupportedSessionAttachmentTypes,
    loadSessionTransportMessages,
} from '@/services/AgentService/session/transport';

const { loadSessionContext } = vi.hoisted(() => ({ loadSessionContext: vi.fn() }));

vi.mock('@services/NativeService', () => ({
    native: { database: { operation: loadSessionContext } },
}));

const ATTACHMENT_CAPABILITIES = { supportsImages: false, supportsFiles: false };

function createRows(sessionId = 7): MessageRow[] {
    return [
        {
            id: 1,
            session_id: sessionId,
            role: 'user',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            attachments: [],
            parts: [],
        },
    ] as unknown as MessageRow[];
}

function resolveContext(
    rows: MessageRow[],
    summaryPart: MessagePartEntity | null = null
): { messages: MessageRow[]; summaryPart: MessagePartEntity | null } {
    return { messages: rows, summaryPart };
}

describe('createSessionReadModel', () => {
    beforeEach(() => {
        loadSessionContext.mockReset();
        loadSessionContext.mockImplementation(async ({ sessionId }: { sessionId: number }) =>
            resolveContext(createRows(sessionId))
        );
    });

    it('user gets one session snapshot for attachment checks and transport rebuild', async () => {
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

        expect(loadSessionContext).toHaveBeenCalledTimes(1);
        expect(loadSessionContext).toHaveBeenCalledWith({
            kind: 'session_context',
            sessionId: 7,
        });
    });

    it('user gets a fresh session read for each consumer without a read model', async () => {
        await findUnsupportedSessionAttachmentTypes({
            sessionId: 7,
            capabilities: ATTACHMENT_CAPABILITIES,
        });
        await loadSessionTransportMessages({
            sessionId: 7,
            attachmentCapabilities: ATTACHMENT_CAPABILITIES,
        });

        expect(loadSessionContext).toHaveBeenCalledTimes(2);
    });

    it('user shares one in-flight read per session and isolates other sessions', async () => {
        const readModel = createSessionReadModel();
        const [first, second] = await Promise.all([
            readModel.getContext(7),
            readModel.getContext(7),
        ]);

        expect(first).toBe(second);
        expect(loadSessionContext).toHaveBeenCalledTimes(1);

        await readModel.getMessages(8);
        expect(loadSessionContext).toHaveBeenCalledTimes(2);
    });

    it('user retries a failed read instead of caching the failure', async () => {
        const readModel = createSessionReadModel();
        loadSessionContext
            .mockRejectedValueOnce(new Error('read interrupted'))
            .mockImplementationOnce(async ({ sessionId }: { sessionId: number }) =>
                resolveContext(createRows(sessionId))
            );

        await expect(readModel.getContext(7)).rejects.toThrow('read interrupted');
        await expect(readModel.getMessages(7)).resolves.toHaveLength(1);
        expect(loadSessionContext).toHaveBeenCalledTimes(2);
    });
});
