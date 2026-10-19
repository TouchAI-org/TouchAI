import { describe, expect, it } from 'vitest';

import { createMigratedDatabase, listIndexes } from './utils/migrations';

describe('session message query indexes', () => {
    it('scopes message history reads by session without scanning the table', () => {
        const db = createMigratedDatabase();
        try {
            expect(listIndexes(db, 'messages')).toContain('messages_session_id_id_idx');

            const plan = db
                .prepare(
                    'EXPLAIN QUERY PLAN SELECT id FROM messages WHERE session_id = ? ORDER BY id'
                )
                .all(1);
            const details = plan.map((row) => String(row.detail)).join('\n');
            expect(details).toContain('messages_session_id_id_idx');
            expect(details).not.toMatch(/SCAN messages\b/);
        } finally {
            db.close();
        }
    });

    it('orders the session list with the activity expression index', () => {
        const db = createMigratedDatabase();
        try {
            expect(listIndexes(db, 'sessions')).toContain('sessions_activity_idx');

            const plan = db
                .prepare(
                    `EXPLAIN QUERY PLAN
                     SELECT id FROM sessions
                     ORDER BY coalesce(last_message_at, updated_at) DESC, id DESC
                     LIMIT 40`
                )
                .all();
            const details = plan.map((row) => String(row.detail)).join('\n');
            expect(details).toContain('sessions_activity_idx');
            expect(details).not.toContain('TEMP B-TREE');
        } finally {
            db.close();
        }
    });

    it('uses the session turn composite index for latest-turn lookups', () => {
        const db = createMigratedDatabase();
        try {
            expect(listIndexes(db, 'session_turns')).toContain('session_turns_session_created_idx');

            const plan = db
                .prepare(
                    `EXPLAIN QUERY PLAN
                     SELECT id FROM session_turns
                     WHERE session_id = ?
                     ORDER BY created_at DESC, id DESC
                     LIMIT 1`
                )
                .all(1);
            const details = plan.map((row) => String(row.detail)).join('\n');
            expect(details).toContain('session_turns_session_created_idx');
        } finally {
            db.close();
        }
    });
});
