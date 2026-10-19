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

    it('projects tool id and server id as read-only generated columns', () => {
        const db = createMigratedDatabase();
        try {
            db.exec(
                "INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'search', 'Session', 'test')"
            );
            db.exec("INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'tool_call')");

            const insertPart = db.prepare(
                'INSERT INTO message_parts (message_id, type, content, data, sort_order) VALUES (1, ?, ?, ?, ?)'
            );
            insertPart.run(
                'tool_call',
                '',
                JSON.stringify({ toolCallId: 'call-1', toolKind: 'builtin', tool_id: 'bash' }),
                0
            );
            insertPart.run(
                'tool_call',
                '',
                JSON.stringify({ toolCallId: 'call-2', toolKind: 'mcp', server_id: 7 }),
                1
            );
            insertPart.run('text', 'plain', '{}', 2);

            const rows = db
                .prepare('SELECT tool_id, server_id FROM message_parts ORDER BY id')
                .all();
            expect(rows).toEqual([
                { tool_id: 'bash', server_id: null },
                { tool_id: null, server_id: 7 },
                { tool_id: null, server_id: null },
            ]);
        } finally {
            db.close();
        }
    });

    it('filters builtin tool logs by projected tool id with the composite index', () => {
        const db = createMigratedDatabase();
        try {
            expect(listIndexes(db, 'message_parts')).toContain('message_parts_tool_id_idx');
            seedToolParts(db, (index) =>
                index % 2 === 0
                    ? { toolKind: 'builtin', tool_id: 'bash' }
                    : { toolKind: 'builtin', tool_id: 'web_fetch' }
            );

            const plan = db
                .prepare(
                    `EXPLAIN QUERY PLAN
                     SELECT id FROM message_parts
                     WHERE type = 'tool_call' AND tool_kind = 'builtin' AND tool_id = 'bash'
                     ORDER BY created_at DESC, id DESC
                     LIMIT 50`
                )
                .all();
            const details = plan.map((row) => String(row.detail)).join('\n');
            expect(details).toContain('message_parts_tool_id_idx');
            expect(details).not.toMatch(/SCAN message_parts\b/);
        } finally {
            db.close();
        }
    });

    it('filters MCP tool logs by projected server id with the composite index', () => {
        const db = createMigratedDatabase();
        try {
            expect(listIndexes(db, 'message_parts')).toContain('message_parts_server_id_idx');
            seedToolParts(db, (index) => ({ toolKind: 'mcp', server_id: index % 3 }));

            const plan = db
                .prepare(
                    `EXPLAIN QUERY PLAN
                     SELECT id FROM message_parts
                     WHERE type = 'tool_call' AND tool_kind = 'mcp' AND server_id = 1
                     ORDER BY created_at DESC, id DESC
                     LIMIT 50`
                )
                .all();
            const details = plan.map((row) => String(row.detail)).join('\n');
            expect(details).toContain('message_parts_server_id_idx');
            expect(details).not.toMatch(/SCAN message_parts\b/);
        } finally {
            db.close();
        }
    });
});

function seedToolParts(
    db: ReturnType<typeof createMigratedDatabase>,
    buildData: (index: number) => Record<string, unknown>
): void {
    db.exec(
        "INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'search', 'Session', 'test')"
    );
    db.exec("INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'tool_call')");
    const insertPart = db.prepare(
        'INSERT INTO message_parts (message_id, type, content, data, sort_order) VALUES (1, ?, ?, ?, ?)'
    );
    for (let index = 0; index < 400; index += 1) {
        insertPart.run(
            'tool_call',
            '',
            JSON.stringify({ toolCallId: `call-${index}`, ...buildData(index) }),
            index
        );
    }
}
