import type { DatabaseSync } from 'node:sqlite';

import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionPendingMessages } from '@/database/schema';
import { PendingMessagePersistence } from '@/services/AgentService/task/pendingMessagePersistence';
import type { PendingUserMessage } from '@/services/AgentService/task/types';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '../../../database/sqliteHarness';

function queuedMessage(
    id: string,
    prompt: string,
    overrides: Partial<PendingUserMessage> = {}
): PendingUserMessage {
    return {
        id,
        prompt,
        delivery: 'queue',
        attachments: [],
        createdAt: 1_700_000_000_000,
        ...overrides,
    };
}

function seedSession(database: DatabaseSync): void {
    database
        .prepare(
            "INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (3, 'Provider', 'openai', 'http://test', '')"
        )
        .run();
    database
        .prepare(
            "INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'session-1', 'Session', 'model-1')"
        )
        .run();
}

describe('when the app restarts with durable pending messages', () => {
    let database: DatabaseSync;

    beforeEach(() => {
        database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database);
    });

    afterEach(() => {
        closeTestDatabases();
    });

    it('user gets the queued prompts and their payload restored in order', async () => {
        const first = new PendingMessagePersistence();
        first.enqueue(
            1,
            queuedMessage('pending-1', 'first', {
                modelId: 'model-a',
                providerId: 3,
                inputSnapshot: {
                    text: 'first',
                    attachments: [],
                    skills: [{ name: 'review', path: '/skills/review.md' }],
                    editorDoc: {
                        type: 'doc',
                        content: [
                            { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
                        ],
                    },
                    excludeFromHistory: true,
                },
            })
        );
        first.enqueue(1, queuedMessage('pending-2', 'second'));
        await first.flush(1);

        const restored = await new PendingMessagePersistence().load(1);

        expect(restored).toEqual([
            expect.objectContaining({
                id: 'pending-1',
                prompt: 'first',
                delivery: 'queue',
                modelId: 'model-a',
                providerId: 3,
                inputSnapshot: expect.objectContaining({
                    text: 'first',
                    skills: [{ name: 'review', path: '/skills/review.md' }],
                    excludeFromHistory: true,
                    editorDoc: expect.objectContaining({ type: 'doc' }),
                }),
            }),
            expect.objectContaining({
                id: 'pending-2',
                prompt: 'second',
                delivery: 'queue',
            }),
        ]);
    });

    it('user gets queued prompts restored in the order they dragged them', async () => {
        const persistence = new PendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'first'));
        persistence.enqueue(1, queuedMessage('pending-2', 'second'));
        persistence.enqueue(1, queuedMessage('pending-3', 'third'));
        persistence.reorder(1, ['pending-3', 'pending-1', 'pending-2']);
        await persistence.flush(1);

        const rows = database
            .prepare('SELECT id, position FROM session_pending_messages ORDER BY position, id')
            .all() as Array<{ id: string; position: number }>;

        expect(rows).toEqual([
            { id: 'pending-3', position: 0 },
            { id: 'pending-1', position: 1 },
            { id: 'pending-2', position: 2 },
        ]);
        expect((await persistence.load(1)).map((message) => message.prompt)).toEqual([
            'third',
            'first',
            'second',
        ]);
    });

    it('user gets queue edits, removals, and model changes restored', async () => {
        const persistence = new PendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'first'));
        persistence.enqueue(1, queuedMessage('pending-2', 'remove me'));
        persistence.update(
            1,
            queuedMessage('pending-1', 'first edited', {
                modelId: 'model-b',
                providerId: 3,
            })
        );
        persistence.remove(1, 'pending-2');
        persistence.updateModel(1, 'model-c', 3);
        await persistence.flush(1);

        const restored = await new PendingMessagePersistence().load(1);

        expect(restored).toEqual([
            expect.objectContaining({
                id: 'pending-1',
                prompt: 'first edited',
                modelId: 'model-c',
                providerId: 3,
            }),
        ]);
    });

    it('user gets the whole queue removed when they clear it', async () => {
        const persistence = new PendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'first'));
        persistence.enqueue(1, queuedMessage('pending-2', 'second'));
        persistence.clear(1);
        await persistence.flush(1);

        await expect(new PendingMessagePersistence().load(1)).resolves.toEqual([]);
    });

    it('user keeps the prompt when one attachment hash no longer resolves', async () => {
        database
            .prepare(
                `INSERT INTO session_pending_messages (
                    id, session_id, position, prompt, payload_json
                ) VALUES (?, 1, 0, ?, ?)`
            )
            .run(
                'pending-1',
                'keep me',
                JSON.stringify({
                    attachments: [
                        {
                            hash: 'missing-hash',
                            originPath: '/tmp/missing.png',
                            name: 'missing.png',
                            type: 'image',
                        },
                    ],
                })
            );

        const restored = await new PendingMessagePersistence().load(1);

        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
            id: 'pending-1',
            prompt: 'keep me',
            attachments: [],
        });
    });

    it('user gets the pending queue removed when its session is deleted', async () => {
        const persistence = new PendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'first'));
        await persistence.flush(1);

        database.prepare('DELETE FROM sessions WHERE id = 1').run();

        const row = database
            .prepare('SELECT count(*) AS count FROM session_pending_messages')
            .get() as { count: number };
        expect(row.count).toBe(0);
    });

    it('user gets invalid stored payloads dropped without losing the rest of the queue', async () => {
        database.exec('PRAGMA ignore_check_constraints = ON');
        database
            .prepare(
                `INSERT INTO session_pending_messages (
                    id, session_id, position, prompt, payload_json
                ) VALUES
                    ('pending-invalid-json', 1, 0, 'invalid json', 'not-json'),
                    ('pending-array', 1, 1, 'array payload', '[]'),
                    ('pending-valid', 1, 2, 'keep me', '{}')`
            )
            .run();

        const restored = await new PendingMessagePersistence().load(1);

        expect(restored).toEqual([
            expect.objectContaining({
                id: 'pending-valid',
                prompt: 'keep me',
            }),
        ]);
        const rows = database
            .prepare('SELECT id FROM session_pending_messages ORDER BY position')
            .all() as Array<{ id: string }>;
        expect(rows).toEqual([{ id: 'pending-valid' }]);
    });
});

describe('when queued messages reference session data', () => {
    it('user gets queue rows removed with their session and detached from a deleted provider', () => {
        const config = getTableConfig(sessionPendingMessages);

        expect(config.foreignKeys).toHaveLength(2);
    });
});
