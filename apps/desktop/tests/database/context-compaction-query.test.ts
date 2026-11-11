import { afterEach, describe, expect, it } from 'vitest';

import { readContextSummary } from '@/services/AgentService/contracts/context';
import { createSessionReadModel } from '@/services/AgentService/session/readModel';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

function summaryData(id: string, firstKeptMessageId: number): string {
    return JSON.stringify({
        version: 2,
        id,
        firstKeptMessageId,
        systemMessageIds: [],
        createdAt: 100,
        tokensBefore: 500,
        tokensAfter: 100,
    });
}

describe('given completed checkpoints across multiple sessions', () => {
    afterEach(closeTestDatabases);

    it('user reopens after the clock moves backwards and receives the last committed summary', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'clock-test', 'Test', 'test');
            INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant'), (2, 1, 'assistant');
        `);
        database
            .prepare(
                `INSERT INTO message_parts
                    (message_id, type, content, data, sort_order, started_at)
                 VALUES (1, 'context_compaction', 'older summary', ?, 0, 200),
                        (2, 'context_compaction', 'last committed summary', ?, 0, 100)`
            )
            .run(
                summaryData('00000000-0000-4000-8000-000000000001', 1),
                summaryData('00000000-0000-4000-8000-000000000002', 2)
            );

        const context = await createSessionReadModel().getContext(1);
        expect(context.summaryPart).toMatchObject({
            message_id: 2,
            content: 'last committed summary',
        });
        expect(context.summaryPart && readContextSummary(context.summaryPart)).toMatchObject({
            id: '00000000-0000-4000-8000-000000000002',
        });
    });

    it('user opens an older session and gets only its latest checkpoint', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES
                (1, 'old', 'Old', 'test'), (2, 'new', 'New', 'test'), (3, 'empty', 'Empty', 'test');
            INSERT INTO messages (id, session_id, role) VALUES
                (1, 1, 'assistant'), (2, 2, 'assistant'), (3, 1, 'assistant');
        `);
        database
            .prepare(
                `INSERT INTO message_parts
                    (message_id, type, content, data, sort_order, started_at)
                 VALUES (1, 'context_compaction', 'old summary', ?, 0, 100),
                        (2, 'context_compaction', 'other session', ?, 0, 999),
                        (3, 'context_compaction', 'updated summary', ?, 0, 200),
                        (3, 'context_compaction', 'latest summary', ?, 1, 200)`
            )
            .run(
                summaryData('00000000-0000-4000-8000-000000000011', 1),
                summaryData('00000000-0000-4000-8000-000000000012', 2),
                summaryData('00000000-0000-4000-8000-000000000013', 3),
                summaryData('00000000-0000-4000-8000-000000000014', 3)
            );

        const oldContext = await createSessionReadModel().getContext(1);
        expect(oldContext.summaryPart).toMatchObject({ content: 'latest summary' });
        expect(
            oldContext.messages.flatMap((message) => message.parts).map((part) => part.content)
        ).not.toContain('other session');

        await expect(createSessionReadModel().getContext(3)).resolves.toEqual({
            messages: [],
            summaryPart: null,
        });
    });

    it('user restores retained attachments without scanning attachments in unrelated conversations', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO sessions(id, session_id, title, model) VALUES (1, 'active', 'Active', 'test'), (2, 'other', 'Other', 'test');
            INSERT INTO messages(id, session_id, role) VALUES (1, 1, 'user'), (2, 2, 'user');
            INSERT INTO attachments(id, hash, type, original_name, origin_path) VALUES (1, 'a', 'file', 'a.txt', '/a'), (2, 'b', 'file', 'b.txt', '/b');
            INSERT INTO message_parts(message_id, type, content, data, sort_order) VALUES
                (1, 'attachment', '', '{"attachmentId":1}', 0), (2, 'attachment', '', '{"attachmentId":2}', 0);
        `);

        const context = await createSessionReadModel().getContext(1);
        expect(context.messages).toHaveLength(1);
        expect(context.messages[0]?.attachments).toEqual([
            expect.objectContaining({ id: 1, message_id: 1 }),
        ]);
    });
});
