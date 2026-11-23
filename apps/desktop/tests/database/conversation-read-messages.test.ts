import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import { findConversationMessagePage } from '@/database/queries/messages';

afterEach(closeTestDatabases);

function seedMessage(
    database: ReturnType<typeof openMigratedDatabase>,
    input: {
        id: number;
        role: 'user' | 'assistant' | 'system' | 'tool_call';
        content: string;
    }
): void {
    database
        .prepare(
            `INSERT INTO messages (id, session_id, role, created_at, updated_at)
             VALUES (?, 1, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`
        )
        .run(input.id, input.role);
    database
        .prepare(
            `INSERT INTO message_parts (message_id, type, content, data, sort_order)
             VALUES (?, 'text', ?, '{}', 0)`
        )
        .run(input.id, input.content);
}

function seedSession(database: ReturnType<typeof openMigratedDatabase>): void {
    database
        .prepare(
            `INSERT INTO sessions (id, session_id, title, model, created_at, updated_at)
             VALUES (1, 'session-1', 'Session 1', 'model-a', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`
        )
        .run();
}

describe('given a saved conversation needs a paged read', () => {
    it('user reads the newest messages in ascending order without an anchor', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database);
        for (let id = 1; id <= 5; id += 1) {
            seedMessage(database, {
                id,
                role: id % 2 === 0 ? 'assistant' : 'user',
                content: `message-${id}`,
            });
        }

        const rows = await findConversationMessagePage({
            sessionId: 1,
            direction: 'before',
            limit: 3,
            roles: ['user', 'assistant'],
        });

        expect(rows.map((row) => row.id)).toEqual([3, 4, 5]);
        expect(rows.at(-1)).toMatchObject({ role: 'user', content: 'message-5' });
    });

    it('user pages toward older messages and never receives system or tool content', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database);
        for (let id = 1; id <= 5; id += 1) {
            seedMessage(database, { id, role: 'user', content: `message-${id}` });
        }
        seedMessage(database, { id: 6, role: 'system', content: 'system-secret' });
        seedMessage(database, { id: 7, role: 'tool_call', content: 'tool-secret' });

        const rows = await findConversationMessagePage({
            sessionId: 1,
            anchorId: 4,
            direction: 'before',
            limit: 2,
            roles: ['user', 'assistant'],
        });

        expect(rows.map((row) => row.id)).toEqual([2, 3]);
        expect(JSON.stringify(rows)).not.toContain('secret');
    });

    it('user pages toward newer messages after an anchor', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        seedSession(database);
        for (let id = 1; id <= 5; id += 1) {
            seedMessage(database, {
                id,
                role: id % 2 === 0 ? 'assistant' : 'user',
                content: `message-${id}`,
            });
        }

        const rows = await findConversationMessagePage({
            sessionId: 1,
            anchorId: 2,
            direction: 'after',
            limit: 2,
            roles: ['user', 'assistant'],
        });

        expect(rows.map((row) => row.id)).toEqual([3, 4]);
    });
});
