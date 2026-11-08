import { db } from '@database';
import { syncOutputParts } from '@database/queries/messageParts';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContextWindow } from '@/services/AgentService/execution/context';
import { loadSessionHistory } from '@/services/AgentService/session/history';
import { createSessionReadModel } from '@/services/AgentService/session/readModel';
import {
    findUnsupportedSessionAttachmentTypes,
    loadSessionTransportMessages,
} from '@/services/AgentService/session/transport';

describe('given a saved context boundary and archived attachments', () => {
    let database: ReturnType<typeof openMigratedDatabase>;
    beforeEach(() => {
        database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'context-v2', 'Context', 'original');
            INSERT INTO messages (id, session_id, role) VALUES
                (1, 1, 'system'), (2, 1, 'user'), (3, 1, 'assistant'),
                (4, 1, 'user'), (5, 1, 'tool_call'), (6, 1, 'assistant');
            INSERT INTO message_parts (message_id, type, content, sort_order) VALUES
                (1, 'text', 'Keep all backups.', 0), (2, 'text', 'Archived image', 0),
                (3, 'text', 'Old response', 0), (4, 'text', 'Finish testing', 0),
                (6, 'text', 'Current answer', 1);
            INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type, size)
                VALUES (1, 'missing-image-hash', 'image', 'old.png', '/missing/old.png', 'image/png', 100);
            INSERT INTO message_parts (message_id, type, content, data, sort_order) VALUES
                (2, 'attachment', '', '{"attachmentId":1}', 1),
                (5, 'tool_call', '', '{"toolCallId":"call-1","toolKind":"builtin","tool_id":"read_file","input":"{}","output":"Verified","status":"success"}', 0);
        `);
        database
            .prepare(
                `INSERT INTO message_parts (message_id, type, content, data, sort_order, started_at)
            VALUES (6, 'context_compaction', 'Tests are pending; image findings are recorded.', ?, 0, 100)`
            )
            .run(
                JSON.stringify({
                    version: 2,
                    id: '00000000-0000-4000-8000-000000000001',
                    firstKeptMessageId: 5,
                    pinnedUserMessageId: 4,
                    systemMessageIds: [1],
                    model: 'original',
                    providerId: 1,
                    createdAt: 100,
                    tokensBefore: 5000,
                    tokensAfter: 300,
                })
            );
    });
    afterEach(closeTestDatabases);

    it.each(['complete', 'missing', 'malformed'])(
        'user resumes with %s diagnostics and reuses the summary and divider without loading archived attachments',
        async (diagnostics) => {
            if (diagnostics === 'missing') {
                database.exec(`UPDATE message_parts SET data = json_remove(data,
                    '$.model', '$.providerId', '$.createdAt', '$.tokensBefore', '$.tokensAfter')
                    WHERE type = 'context_compaction'`);
            } else if (diagnostics === 'malformed') {
                database.exec(`UPDATE message_parts SET data = json_set(data,
                    '$.model', '', '$.providerId', -1, '$.createdAt', 'unknown',
                    '$.tokensBefore', -1, '$.tokensAfter', null)
                    WHERE type = 'context_compaction'`);
            }
            const readModel = createSessionReadModel();
            expect((await readModel.getMessages(1)).map((row) => row.id)).toEqual([1, 4, 5, 6]);
            expect(
                await findUnsupportedSessionAttachmentTypes({
                    sessionId: 1,
                    capabilities: { supportsImages: false, supportsFiles: false },
                    readModel,
                })
            ).toEqual([]);
            const messages = await loadSessionTransportMessages({ sessionId: 1, readModel });
            expect(messages.map((message) => message.role)).toEqual([
                'system',
                'user',
                'user',
                'assistant',
                'tool',
                'assistant',
            ]);
            expect(JSON.stringify(messages)).toContain('Tests are pending');
            expect(JSON.stringify(messages)).not.toContain('Archived image');
            expect(messages.find((message) => message.role === 'tool')?.content).toBe('Verified');
            const prepared = await new ContextWindow().prepare({
                request: { model: 'text-model', messages },
                contextLimit: 8000,
                outputLimit: 1000,
                summarize: async () => {
                    throw new Error('The saved summary must remain reusable');
                },
                saveSummary: async () => {
                    throw new Error('Reopening must not write another summary');
                },
            });
            expect(prepared.messages).toEqual(messages);
            expect(
                (await loadSessionHistory(1))
                    .flatMap((message) => message.parts)
                    .filter((part) => part.type === 'context_compaction')
            ).toEqual([
                expect.objectContaining({
                    id: '00000000-0000-4000-8000-000000000001',
                    state: 'compacted',
                }),
            ]);
        }
    );

    it('user receives more text in the current answer and continues reusing the checkpoint', async () => {
        await db.transaction((tx) =>
            syncOutputParts(
                6,
                [{ message_id: 6, type: 'text', content: 'Updated answer', sort_order: 1 }],
                tx
            )
        );
        expect((await createSessionReadModel().getMessages(1)).map((row) => row.id)).toEqual([
            1, 4, 5, 6,
        ]);
    });

    it('user opens a checkpoint with a missing retained reference and safely reads the original history', async () => {
        database.exec(
            "UPDATE message_parts SET data = json_set(data, '$.firstKeptMessageId', 999) WHERE type = 'context_compaction'"
        );
        expect((await createSessionReadModel().getMessages(1)).map((row) => row.id)).toEqual([
            1, 2, 3, 4, 5, 6,
        ]);
    });
});
