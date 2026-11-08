import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionReadModel } from '@/services/AgentService/session/readModel';
import {
    findUnsupportedSessionAttachmentTypes,
    loadSessionTransportMessages,
} from '@/services/AgentService/session/transport';

describe('given a conversation being read for a new request', () => {
    let database: ReturnType<typeof openMigratedDatabase>;
    beforeEach(() => {
        database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO sessions(id, session_id, title, model) VALUES (7, 'seven', 'Seven', 'test'), (8, 'eight', 'Eight', 'test');
            INSERT INTO messages(id, session_id, role) VALUES (1, 7, 'user'), (2, 8, 'user');
            INSERT INTO message_parts(message_id, type, content, sort_order) VALUES (1, 'text', 'Original', 0), (2, 'text', 'Other session', 0);
        `);
    });
    afterEach(closeTestDatabases);

    it('user gets the same history snapshot for capability checking and sending despite a later edit', async () => {
        const readModel = createSessionReadModel();
        await findUnsupportedSessionAttachmentTypes({
            sessionId: 7,
            capabilities: { supportsImages: false, supportsFiles: false },
            readModel,
        });
        database.exec("UPDATE message_parts SET content='Edited' WHERE message_id=1");
        expect(await loadSessionTransportMessages({ sessionId: 7, readModel })).toEqual([
            expect.objectContaining({ content: 'Original' }),
        ]);
        expect(await loadSessionTransportMessages({ sessionId: 7 })).toEqual([
            expect.objectContaining({ content: 'Edited' }),
        ]);
    });

    it('user reads concurrently and gets one consistent snapshot isolated from other sessions', async () => {
        const readModel = createSessionReadModel();
        const [first, second] = await Promise.all([
            readModel.getContext(7),
            readModel.getContext(7),
        ]);
        expect(first).toBe(second);
        expect((await readModel.getMessages(8))[0]?.parts[0]?.content).toBe('Other session');
    });

    it('user retries after a failed read and can recover the conversation', async () => {
        const readModel = createSessionReadModel();
        routeQueriesTo(database, {
            beforeCommit: () => {
                throw new Error('Read interrupted');
            },
        });
        await expect(readModel.getContext(7)).rejects.toThrow('Read interrupted');
        routeQueriesTo(database);
        expect((await readModel.getMessages(7))[0]?.parts[0]?.content).toBe('Original');
    });
});
