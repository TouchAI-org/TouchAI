import type { DatabaseSync } from 'node:sqlite';

import { mockTauriCommand } from '@tests/utils/tauri';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPendingMessagePersistence } from '@/app/workflows/agent/pending';
import { buildPromptAttachmentSlots } from '@/app/workflows/agent/transport';
import { sessionPendingMessages } from '@/database/schema';
import type { PendingUserMessage } from '@/modules/agent/contracts';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '../../database/sqliteHarness';

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
        const first = createPendingMessagePersistence();
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

        const restored = await createPendingMessagePersistence().load(1);

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
        const persistence = createPendingMessagePersistence();
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

    it.each([0, 6, 12])(
        'user restarts with an image at text offset %s and sends it in the original position',
        async (offset) => {
            database
                .prepare(
                    `INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type)
            VALUES (1, 'image-hash', 'image', 'photo.png', '/test/photo.png', 'image/png')`
                )
                .run();
            mockTauriCommand('get_app_directory_path', '/test/cache');
            mockTauriCommand('plugin:path|join', (payload: unknown) =>
                (payload as { paths: string[] }).paths.join('/')
            );
            mockTauriCommand('plugin:fs|mkdir', undefined);
            mockTauriCommand('plugin:fs|exists', true);
            const message = queuedMessage('image-order', 'Before after', {
                attachments: [
                    {
                        id: 'image',
                        attachmentId: 1,
                        hash: 'image-hash',
                        type: 'image',
                        name: 'photo.png',
                        originPath: '/test/photo.png',
                        path: '/test/cache/photo.png',
                        draftInsertionOffset: offset,
                    },
                ],
            });
            const persistence = createPendingMessagePersistence();
            persistence.enqueue(1, message);
            await persistence.flush(1);

            const restored = (await createPendingMessagePersistence().load(1))[0]!;
            const slots = (input: PendingUserMessage) =>
                buildPromptAttachmentSlots(input.prompt, input.attachments).map((slot) =>
                    slot.type === 'text' ? slot.text : '<image>'
                );

            expect(slots(restored)).toEqual(slots(message));
            expect(restored.inputSnapshot?.attachments[0]?.draftInsertionOffset).toBe(offset);
        }
    );

    it('user gets queue edits, removals, and model changes restored', async () => {
        const persistence = createPendingMessagePersistence();
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

        const restored = await createPendingMessagePersistence().load(1);

        expect(restored).toEqual([
            expect.objectContaining({
                id: 'pending-1',
                prompt: 'first edited',
                modelId: 'model-c',
                providerId: 3,
            }),
        ]);
    });

    it('user restarts with the same image pasted twice and sends both references in their original positions', async () => {
        database
            .prepare(
                `INSERT INTO attachments (id, hash, type, original_name, origin_path, mime_type)
            VALUES (1, 'shared-image', 'image', 'photo.png', '/test/photo.png', 'image/png')`
            )
            .run();
        mockTauriCommand('get_app_directory_path', '/test/cache');
        mockTauriCommand('plugin:path|join', (payload: unknown) =>
            (payload as { paths: string[] }).paths.join('/')
        );
        mockTauriCommand('plugin:fs|mkdir', undefined);
        mockTauriCommand('plugin:fs|exists', true);
        const persistence = createPendingMessagePersistence();
        persistence.enqueue(
            1,
            queuedMessage('repeated-image', 'Before between after', {
                attachments: [6, 14].map((offset) => ({
                    id: `image-${offset}`,
                    attachmentId: 1,
                    hash: 'shared-image',
                    type: 'image',
                    name: 'photo.png',
                    originPath: '/test/photo.png',
                    path: '/test/cache/photo.png',
                    draftInsertionOffset: offset,
                })),
            })
        );
        await persistence.flush(1);

        const restored = (await createPendingMessagePersistence().load(1))[0]!;

        expect(
            buildPromptAttachmentSlots(restored.prompt, restored.attachments).map((slot) =>
                slot.type === 'text' ? slot.text : `<${slot.attachment.hash}>`
            )
        ).toEqual(['Before', '<shared-image>', ' between', '<shared-image>', ' after']);
        expect(restored.attachments[0]?.id).not.toBe(restored.attachments[1]?.id);
        expect(
            restored.inputSnapshot?.attachments.map((attachment) => attachment.draftInsertionOffset)
        ).toEqual([6, 14]);
    });

    it('user gets the whole queue removed when they clear it', async () => {
        const persistence = createPendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'first'));
        persistence.enqueue(1, queuedMessage('pending-2', 'second'));
        persistence.clear(1);
        await persistence.flush(1);

        await expect(createPendingMessagePersistence().load(1)).resolves.toEqual([]);
    });

    it('user gets an unresolved write error until the complete queued prompt is durably saved', async () => {
        database.exec(`CREATE TEMP TRIGGER pending_write_failure
            BEFORE INSERT ON session_pending_messages
            BEGIN SELECT RAISE(ABORT, 'queue storage unavailable'); END`);
        const persistence = createPendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'retry me'));

        await expect(persistence.flush(1)).rejects.toThrow('queue storage unavailable');
        expect(database.prepare('SELECT id FROM session_pending_messages').all()).toEqual([]);

        database.exec('DROP TRIGGER pending_write_failure');
        await expect(persistence.flush(1)).resolves.toBeUndefined();
        await expect(createPendingMessagePersistence().load(1)).resolves.toEqual([
            expect.objectContaining({ id: 'pending-1', prompt: 'retry me' }),
        ]);
    });

    it('user recovers the latest edits, removals, model and order after storage becomes available', async () => {
        database.exec(`CREATE TEMP TRIGGER pending_write_failure
            BEFORE INSERT ON session_pending_messages
            BEGIN SELECT RAISE(ABORT, 'queue storage unavailable'); END`);
        const persistence = createPendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'original'));
        persistence.enqueue(1, queuedMessage('pending-2', 'remove me'));
        await persistence.flush(1).catch(() => undefined);

        persistence.update(1, queuedMessage('pending-1', 'saved edit'));
        persistence.remove(1, 'pending-2');
        persistence.enqueue(1, queuedMessage('pending-3', 'new message'));
        persistence.updateModel(1, 'model-c', 3);
        persistence.reorder(1, ['pending-3', 'pending-1']);
        database.exec('DROP TRIGGER pending_write_failure');
        await persistence.flush(1);

        await expect(createPendingMessagePersistence().load(1)).resolves.toEqual([
            expect.objectContaining({
                id: 'pending-3',
                prompt: 'new message',
                modelId: 'model-c',
                providerId: 3,
            }),
            expect.objectContaining({
                id: 'pending-1',
                prompt: 'saved edit',
                modelId: 'model-c',
                providerId: 3,
            }),
        ]);
    });

    it('user keeps every attachment in a queued prompt when caching fails and is later retried', async () => {
        mockTauriCommand('plugin:fs|stat', () => {
            throw new Error('attachment unavailable');
        });
        const persistence = createPendingMessagePersistence();
        persistence.enqueue(
            1,
            queuedMessage('pending-1', 'with my folder', {
                attachments: [
                    {
                        id: 'draft-folder',
                        type: 'file',
                        path: '/test/docs',
                        originPath: '/test/docs',
                        name: 'docs',
                        supportStatus: 'supported',
                    },
                ],
            })
        );

        await expect(persistence.flush(1)).rejects.toThrow('attachment unavailable');
        expect(database.prepare('SELECT id FROM session_pending_messages').all()).toEqual([]);

        mockTauriCommand('plugin:fs|stat', {
            isDirectory: true,
            isFile: false,
            isSymlink: false,
            size: 0,
        });
        mockTauriCommand('plugin:fs-pro|full_name', 'docs');
        await persistence.flush(1);
        const restored = await createPendingMessagePersistence().load(1);

        expect(restored).toEqual([
            expect.objectContaining({
                id: 'pending-1',
                prompt: 'with my folder',
                attachments: [
                    expect.objectContaining({
                        name: 'docs',
                        originPath: '/test/docs',
                        hash: expect.any(String),
                    }),
                ],
            }),
        ]);
    });

    it.each(['commit', 'rollback'] as const)(
        'user keeps newer edits, removals and explicit models when an earlier write reaches %s',
        async (outcome) => {
            const persistence = createPendingMessagePersistence();
            let changed = false;
            routeQueriesTo(database, {
                beforeCommit: () => {
                    if (changed) return;
                    changed = true;
                    persistence.update(1, queuedMessage('pending-1', 'latest edit'));
                    persistence.remove(1, 'pending-2');
                    persistence.updateModel(1, 'shared-model', 3);
                    persistence.enqueue(
                        1,
                        queuedMessage('pending-3', 'new message', {
                            modelId: 'explicit-model',
                            providerId: 3,
                        })
                    );
                    persistence.reorder(1, ['pending-3', 'pending-1']);
                    if (outcome === 'rollback') throw new Error('commit unavailable');
                },
            });
            persistence.enqueue(1, queuedMessage('pending-1', 'original'));
            persistence.enqueue(1, queuedMessage('pending-2', 'remove me'));

            if (outcome === 'rollback') {
                await expect(persistence.flush(1)).rejects.toThrow('commit unavailable');
                expect(database.prepare('SELECT id FROM session_pending_messages').all()).toEqual(
                    []
                );
            }
            await persistence.flush(1);

            await expect(createPendingMessagePersistence().load(1)).resolves.toEqual([
                expect.objectContaining({
                    id: 'pending-3',
                    prompt: 'new message',
                    modelId: 'explicit-model',
                }),
                expect.objectContaining({
                    id: 'pending-1',
                    prompt: 'latest edit',
                    modelId: 'shared-model',
                }),
            ]);
        }
    );

    it('user clears a failed queue and persists only messages submitted after the clear', async () => {
        const persistence = createPendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'old committed prompt'));
        await persistence.flush(1);
        database.exec(`CREATE TEMP TRIGGER pending_write_failure
            BEFORE UPDATE ON session_pending_messages
            BEGIN SELECT RAISE(ABORT, 'queue storage unavailable'); END`);
        persistence.update(1, queuedMessage('pending-1', 'failed edit'));
        await expect(persistence.flush(1)).rejects.toThrow('queue storage unavailable');

        persistence.clear(1);
        persistence.enqueue(1, queuedMessage('pending-2', 'after clearing'));
        database.exec('DROP TRIGGER pending_write_failure');
        await persistence.flush(1);

        await expect(createPendingMessagePersistence().load(1)).resolves.toEqual([
            expect.objectContaining({ id: 'pending-2', prompt: 'after clearing' }),
        ]);
    });

    it('user repeatedly edits and removes temporary prompts during an outage without reviving stale work', async () => {
        database.exec(`CREATE TEMP TRIGGER pending_write_failure
            BEFORE INSERT ON session_pending_messages
            BEGIN SELECT RAISE(ABORT, 'queue storage unavailable'); END`);
        const persistence = createPendingMessagePersistence();
        persistence.enqueue(1, queuedMessage('pending-1', 'original'));
        await expect(persistence.flush(1)).rejects.toThrow('queue storage unavailable');

        for (let revision = 0; revision < 100; revision += 1) {
            persistence.update(1, queuedMessage('pending-1', `edit ${revision}`));
            const messageId = `temporary-${revision}`;
            persistence.enqueue(1, queuedMessage(messageId, 'remove before recovery'));
            persistence.remove(1, messageId);
        }
        database.exec('DROP TRIGGER pending_write_failure');
        await persistence.flush(1);

        await expect(createPendingMessagePersistence().load(1)).resolves.toEqual([
            expect.objectContaining({ id: 'pending-1', prompt: 'edit 99' }),
        ]);
    });

    it('user restores valid queued prompts while a failed attachment row remains recoverable', async () => {
        database
            .prepare(
                `INSERT INTO attachments (hash, type, original_name, origin_path, mime_type)
            VALUES ('aaa-image', 'image', 'photo.png', '/test/photo.png', 'image/png')`
            )
            .run();
        database
            .prepare(
                `INSERT INTO session_pending_messages (id, session_id, position, prompt, payload_json)
            VALUES ('pending-bad-cache', 1, 0, 'with photo', ?), ('pending-valid', 1, 1, 'plain text', '{}')`
            )
            .run(
                JSON.stringify({
                    attachments: [
                        {
                            hash: 'aaa-image',
                            type: 'image',
                            name: 'photo.png',
                            originPath: '/test/photo.png',
                        },
                    ],
                })
            );
        mockTauriCommand('get_app_directory_path', '/test/cache');
        mockTauriCommand('plugin:path|join', (payload: unknown) =>
            (payload as { paths: string[] }).paths.join('/')
        );
        mockTauriCommand('plugin:fs|mkdir', () => {
            throw new Error('cache unavailable');
        });

        await expect(createPendingMessagePersistence().load(1)).resolves.toEqual([
            expect.objectContaining({ id: 'pending-valid', prompt: 'plain text' }),
        ]);
        expect(
            database.prepare('SELECT id FROM session_pending_messages ORDER BY position').all()
        ).toEqual([{ id: 'pending-bad-cache' }, { id: 'pending-valid' }]);

        mockTauriCommand('plugin:fs|mkdir', undefined);
        const restored = await createPendingMessagePersistence().load(1);
        expect(restored.map((message) => message.id)).toEqual([
            'pending-bad-cache',
            'pending-valid',
        ]);
        expect(restored[0]?.attachments).toEqual([expect.objectContaining({ hash: 'aaa-image' })]);
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

        const restored = await createPendingMessagePersistence().load(1);

        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
            id: 'pending-1',
            prompt: 'keep me',
            attachments: [],
        });
    });

    it('user gets the pending queue removed when its session is deleted', async () => {
        const persistence = createPendingMessagePersistence();
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

        const restored = await createPendingMessagePersistence().load(1);

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
