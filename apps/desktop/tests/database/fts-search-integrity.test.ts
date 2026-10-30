import { describe, expect, it } from 'vitest';

import { createMigratedDatabase, ftsRowIds } from './utils/migrations';

function seedSessionAndMessage() {
    const db = createMigratedDatabase();
    db.exec(`
        INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'fts-scope', 'Test', 'test');
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'tool_call');
    `);
    return db;
}

describe('message search trigger scope', () => {
    it('does not rebuild the message document for non-indexed tool metadata changes', () => {
        const db = seedSessionAndMessage();
        try {
            db.exec(`
                INSERT INTO message_parts (message_id, type, content, data, sort_order)
                VALUES (1, 'tool_call', '',
                    '{"toolCallId":"call-1","toolKind":"builtin","tool_id":"bash","status":"pending","output":"alpha brv chr"}',
                    0);
            `);

            const before = Number(db.prepare('SELECT total_changes() AS n').get()?.n ?? 0);
            db.exec(`UPDATE message_parts SET data = json_set(data, '$.status', 'success')`);
            const after = Number(db.prepare('SELECT total_changes() AS n').get()?.n ?? 0);

            // 只有 UPDATE 本身，不能因为派生索引重建多出 DELETE/INSERT。
            expect(after - before).toBe(1);
            expect(ftsRowIds(db, 'brv')).toEqual([1]);
        } finally {
            db.close();
        }
    });

    it('refreshes the message document when indexed tool output changes', () => {
        const db = seedSessionAndMessage();
        try {
            db.exec(`
                INSERT INTO message_parts (message_id, type, content, data, sort_order)
                VALUES (1, 'tool_call', '',
                    '{"toolCallId":"call-1","toolKind":"builtin","tool_id":"bash","status":"pending","output":"alpha brv chr"}',
                    0);
            `);

            db.exec(`
                UPDATE message_parts
                SET data = json_set(data, '$.output', 'delta ech fox')
            `);

            expect(ftsRowIds(db, 'ech')).toEqual([1]);
            expect(ftsRowIds(db, 'brv')).toEqual([]);
        } finally {
            db.close();
        }
    });

    it('keeps text parts searchable when their content changes', () => {
        const db = seedSessionAndMessage();
        try {
            db.exec(`
                INSERT INTO message_parts (message_id, type, content, data, sort_order)
                VALUES (1, 'text', 'lrm ips', '{}', 0);
            `);

            expect(ftsRowIds(db, 'lrm')).toEqual([1]);

            db.exec(`UPDATE message_parts SET content = 'dlr sit' WHERE type = 'text'`);

            expect(ftsRowIds(db, 'dlr')).toEqual([1]);
            expect(ftsRowIds(db, 'lrm')).toEqual([]);
        } finally {
            db.close();
        }
    });

    it('drops the message document when its last indexed part is removed', () => {
        const db = seedSessionAndMessage();
        try {
            db.exec(`
                INSERT INTO message_parts (message_id, type, content, data, sort_order)
                VALUES (1, 'tool_call', '',
                    '{"toolCallId":"call-1","toolKind":"builtin","tool_id":"bash","status":"pending","output":"alpha brv chr"}',
                    0);
            `);

            db.exec(`DELETE FROM message_parts WHERE message_id = 1`);

            expect(ftsRowIds(db, 'brv')).toEqual([]);
        } finally {
            db.close();
        }
    });
});
