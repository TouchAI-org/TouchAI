import type { SQLInputValue } from 'node:sqlite';

import { findLatestContextCompaction } from '@database/queries/messageParts';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

describe('given completed checkpoints across multiple sessions', () => {
    afterEach(closeTestDatabases);

    it('user opens an older session and gets its latest checkpoint with session-bounded reads', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES
                (1, 'old', 'Old', 'test'), (2, 'new', 'New', 'test'), (3, 'empty', 'Empty', 'test');
            INSERT INTO messages (id, session_id, role) VALUES
                (1, 1, 'assistant'), (2, 2, 'assistant'), (3, 1, 'assistant');
            INSERT INTO message_parts (message_id, type, content, sort_order, started_at) VALUES
                (1, 'context_compaction', 'old summary', 0, 100),
                (2, 'context_compaction', 'other session', 0, 999),
                (3, 'context_compaction', 'updated summary', 0, 200),
                (3, 'context_compaction', 'latest summary', 1, 200);
        `);
        expect(await findLatestContextCompaction(1)).toMatchObject({ content: 'latest summary' });
        expect(await findLatestContextCompaction(3)).toBeUndefined();
        const calls = getTauriInvokeCalls('database_query');
        const { request } = calls[calls.length - 1]!.payload as {
            request: { sql: string; params: SQLInputValue[] };
        };
        const plan = database.prepare(`EXPLAIN QUERY PLAN ${request.sql}`).all(...request.params);
        const details = plan.map((row) => String(row.detail)).join('\n');
        expect(details).toContain('messages_session_id_id_idx');
        expect(details).toContain('message_parts_message_id_sort_order_idx');
        expect(details).not.toContain('message_parts_llm_call_idx');
    });
});
