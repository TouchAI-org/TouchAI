import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');
const root = 'src/database/drizzle';
const journal = JSON.parse(readFileSync(`${root}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string }[];
};

function applyMigrations(
    db: InstanceType<typeof DatabaseSync>,
    start = 0,
    end = journal.entries.length
) {
    for (const entry of journal.entries.slice(start, end)) {
        db.exec('BEGIN');
        try {
            for (const statement of migrationStatements(entry.tag)) db.exec(statement);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
}

function migrationStatements(tag: string) {
    return readFileSync(`${root}/${tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean);
}

function pendingSnapshotFiles() {
    return readdirSync(`${root}/meta`).filter(
        (file) => /^\d+_snapshot\.json$/.test(file) && Number(file.split('_')[0]) >= 4
    );
}

function migrated() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrations(db);
    return db;
}

describe('complete parts migration', () => {
    it('derives read-only indexed tool identifiers from data', () => {
        const db = migrated();
        try {
            const columns = db.prepare('PRAGMA table_xinfo(message_parts)').all();
            for (const name of ['tool_call_id', 'tool_kind', 'attachment_id']) {
                expect(columns.find((column) => column.name === name)?.hidden).toBe(2);
            }
            db.exec(`
                INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'generated', 'Test', 'test');
                INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant');
                INSERT INTO message_parts (message_id, type, content, data, sort_order)
                VALUES (1, 'tool_call', '', '{"toolCallId":"call-1","toolKind":"builtin","status":"pending"}', 0);
            `);
            expect(
                db.prepare('SELECT tool_call_id, tool_kind, attachment_id FROM message_parts').get()
            ).toEqual({
                tool_call_id: 'call-1',
                tool_kind: 'builtin',
                attachment_id: null,
            });
            db.exec(
                `UPDATE message_parts SET data = json_set(data, '$.toolCallId', 'call-2', '$.toolKind', 'mcp')`
            );
            expect(db.prepare('SELECT tool_call_id, tool_kind FROM message_parts').get()).toEqual({
                tool_call_id: 'call-2',
                tool_kind: 'mcp',
            });
            expect(() => db.exec("UPDATE message_parts SET tool_call_id = 'duplicate'")).toThrow(
                /generated column/
            );
            expect(() =>
                db.exec(
                    "INSERT INTO message_parts (message_id, type, content, data, tool_kind, sort_order) VALUES (1, 'tool_call', '', '{}', 'mcp', 1)"
                )
            ).toThrow(/generated column/);
            const plan = db
                .prepare(
                    "EXPLAIN QUERY PLAN SELECT id FROM message_parts WHERE tool_kind='mcp' AND tool_call_id='call-2'"
                )
                .all();
            expect(
                plan.some((row) => String(row.detail).includes('message_parts_tool_call_idx'))
            ).toBe(true);
            db.exec("UPDATE message_parts SET type = 'text'");
            expect(
                db.prepare('SELECT tool_call_id, tool_kind, attachment_id FROM message_parts').get()
            ).toEqual({
                tool_call_id: null,
                tool_kind: null,
                attachment_id: null,
            });
            expect(() => db.exec("UPDATE message_parts SET data = '[]'")).toThrow();
        } finally {
            db.close();
        }
    });

    it('enforces attachment references and cascades deletion using the virtual projection', () => {
        const db = migrated();
        try {
            db.exec(`
                INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'attachments', 'Test', 'test');
                INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'user');
                INSERT INTO attachments (id, hash, type, original_name, origin_path) VALUES (1, 'hash', 'file', 'test.txt', '/cache/test.txt');
                INSERT INTO message_parts (message_id, type, content, data, sort_order)
                VALUES (1, 'attachment', '', '{"attachmentId":1,"originPath":"/original/test.txt"}', 0);
                INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (1, 'text', 'Keep this body', 1);
            `);
            expect(
                db.prepare("SELECT attachment_id FROM message_parts WHERE type='attachment'").get()
                    ?.attachment_id
            ).toBe(1);
            expect(() =>
                db.exec(
                    "UPDATE message_parts SET data = json_set(data, '$.attachmentId', 999) WHERE type='attachment'"
                )
            ).toThrow(/FOREIGN KEY/);
            expect(() =>
                db.exec("UPDATE message_parts SET data = '{}' WHERE type='attachment'")
            ).toThrow();
            db.exec('BEGIN; DELETE FROM attachments WHERE id=1; ROLLBACK;');
            expect(
                db
                    .prepare("SELECT count(*) AS count FROM message_parts WHERE type='attachment'")
                    .get()?.count
            ).toBe(1);
            db.exec('DELETE FROM attachments WHERE id=1');
            expect(db.prepare('SELECT type, content FROM message_parts').all()).toEqual([
                { type: 'text', content: 'Keep this body' },
            ]);
            expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally {
            db.close();
        }
    });

    it('ships one migration and one final snapshot after the published baseline', () => {
        const pending = journal.entries.slice(4);
        expect(pending).toHaveLength(1);
        expect(pending[0]!.tag).toMatch(/^0004_/);
        const snapshotFiles = pendingSnapshotFiles();
        expect(snapshotFiles).toEqual(['0004_snapshot.json']);
    });
    it('rolls back the consolidated schema and backfill together on failure', () => {
        const db = new DatabaseSync(':memory:');
        db.exec('PRAGMA foreign_keys=ON');
        applyMigrations(db, 0, 4);
        db.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'rollback', 'Test', 'test');
            INSERT INTO messages (id, session_id, role, content, reasoning)
            VALUES (1, 1, 'assistant', 'Original answer', 'Original thought');
        `);
        try {
            db.exec('BEGIN');
            for (const statement of migrationStatements(journal.entries[4]!.tag))
                db.exec(statement);
            expect(() => db.exec('INSERT INTO nonexistent_table VALUES (1)')).toThrow();
            db.exec('ROLLBACK');
            expect(db.prepare('SELECT content, reasoning FROM messages WHERE id=1').get()).toEqual({
                content: 'Original answer',
                reasoning: 'Original thought',
            });
            expect(
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE name IN ('message_parts', 'message_search_fts')"
                    )
                    .all()
            ).toEqual([]);
            expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally {
            db.close();
        }
    });

    it('removes duplicated output and provider credentials from legacy checkpoints', () => {
        const db = new DatabaseSync(':memory:');
        applyMigrations(db, 0, journal.entries.length - 1);
        const checkpoint = {
            activeModel: { id: 7, provider: { api_key: 'secret' } },
            messages: [{ role: 'assistant', content: 'Repeated output' }],
            response: 'Answer',
            reasoning: 'Plan',
            iteration: 2,
            modelSwitchCount: 1,
            modelLanguageContext: { language: 'zh' },
            executedBuiltInToolIds: ['shell'],
        };
        db.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'checkpoint', 'Test', 'test');
            INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo) VALUES (1, 'test', 'openai', 'http://local', '', '');
            INSERT INTO models (id, provider_id, name, model_id) VALUES (7, 1, 'test', 'test');
            INSERT INTO session_turns (id, session_id, model_id, task_id, status, prompt_snapshot_json) VALUES (1, 1, 7, 'task', 'failed', '{}');
        `);
        db.prepare(
            "INSERT INTO session_turn_attempts (turn_id, attempt_index, max_retries, status, checkpoint_json, delivery_manifest_json) VALUES (1, 1, 3, 'failed', ?, '{}')"
        ).run(JSON.stringify(checkpoint));
        applyMigrations(db, journal.entries.length - 1);
        try {
            const result = JSON.parse(
                String(
                    db.prepare('SELECT checkpoint_json FROM session_turn_attempts').get()
                        ?.checkpoint_json
                )
            );
            expect(result).toEqual({
                activeModelId: 7,
                iteration: 2,
                modelSwitchCount: 1,
                modelLanguageContext: { language: 'zh' },
                executedBuiltInToolIds: ['shell'],
                outputBoundary: { textLength: 6, reasoningLength: 4, partCount: 2 },
            });
        } finally {
            db.close();
        }
    });

    it('preserves empty results and does not guess ambiguous legacy tool kinds', () => {
        const db = new DatabaseSync(':memory:');
        db.exec('PRAGMA foreign_keys=ON');
        applyMigrations(db, 0, journal.entries.length - 1);
        db.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'collision', 'Test', 'test');
            INSERT INTO mcp_servers (id, name, transport_type) VALUES (1, 'server', 'stdio');
            INSERT INTO messages (id, session_id, role, content, tool_log_id, tool_log_kind) VALUES
                (1, 1, 'tool_call', '', 1, 'builtin'), (2, 1, 'tool_call', '', 1, 'mcp'),
                (3, 1, 'tool_result', '', 1, 'builtin'), (4, 1, 'tool_result', '', 1, 'mcp'),
                (5, 1, 'tool_result', 'Ambiguous result', 1, NULL), (6, 1, 'tool_result', 'Unmatched result', 99, 'builtin');
            INSERT INTO built_in_tool_logs (id, tool_id, tool_call_id, message_id, iteration, input, status)
            VALUES (1, 'shell', 'builtin-call', 1, 1, '{}', 'completed');
            INSERT INTO mcp_tool_logs (id, server_id, tool_name, tool_call_id, message_id, iteration, input, status)
            VALUES (1, 1, 'tool', 'mcp-call', 2, 1, '{}', 'completed');
        `);
        applyMigrations(db, journal.entries.length - 1);
        try {
            expect(
                db
                    .prepare(
                        "SELECT message_id, content, tool_call_id, tool_kind FROM message_parts WHERE type = 'tool_result' ORDER BY message_id"
                    )
                    .all()
            ).toEqual([
                { message_id: 3, content: '', tool_call_id: 'builtin-call', tool_kind: 'builtin' },
                { message_id: 4, content: '', tool_call_id: 'mcp-call', tool_kind: 'mcp' },
                { message_id: 5, content: 'Ambiguous result', tool_call_id: null, tool_kind: null },
                { message_id: 6, content: 'Unmatched result', tool_call_id: null, tool_kind: null },
            ]);
            expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally {
            db.close();
        }
    });

    it('removes legacy message references and separate content tables', () => {
        const db = migrated();
        try {
            const columns = db
                .prepare('pragma table_info(messages)')
                .all()
                .map((row) => row.name);
            expect(columns).not.toContain('tool_log_id');
            expect(columns).not.toContain('tool_log_kind');
            const tables = db
                .prepare("select name from sqlite_master where type='table'")
                .all()
                .map((row) => row.name);
            for (const table of ['message_attachments', 'mcp_tool_logs', 'built_in_tool_logs']) {
                expect(tables).not.toContain(table);
            }
            const parts = db
                .prepare('pragma table_xinfo(message_parts)')
                .all()
                .map((row) => row.name);
            for (const column of ['attachment_id', 'tool_call_id', 'tool_kind', 'data']) {
                expect(parts).toContain(column);
            }
        } finally {
            db.close();
        }
    });

    it('migrates legacy tools and attachments before removing their tables', () => {
        const db = new DatabaseSync(':memory:');
        db.exec('PRAGMA foreign_keys=ON');
        applyMigrations(db, 0, journal.entries.length - 1);
        db.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'migration-test', 'Test', 'test');
            INSERT INTO messages (id, session_id, role, content, tool_log_id, tool_log_kind)
            VALUES (1, 1, 'tool_call', '', 1, 'builtin'), (2, 1, 'tool_result', 'hi result', 1, 'builtin');
            INSERT INTO attachments (id, hash, type, original_name, origin_path)
            VALUES (1, 'hash-1', 'file', 'one.txt', 'C:/one.txt');
            INSERT INTO message_attachments (message_id, attachment_id, sort_order, origin_path)
            VALUES (1, 1, 4, 'C:/one.txt');
            INSERT INTO built_in_tool_logs
                (id, tool_id, tool_call_id, message_id, iteration, input, output, status, approval_state, duration_ms, error_message)
            VALUES (1, 'shell', 'call-1', 1, 2, '{"command":"echo hi"}', '{"stdout":"hi"}', 'completed', 'approved', 42, NULL);
            INSERT INTO built_in_tool_logs
                (id, tool_id, tool_call_id, session_id, iteration, input, output, status, approval_state, duration_ms, error_message)
            VALUES (2, 'shell', 'orphan-call', 1, 1, '{"command":"echo orphan"}', NULL, 'failed', 'none', NULL, 'failed');
        `);
        applyMigrations(db, journal.entries.length - 1);
        try {
            const parts = db
                .prepare(
                    `
                    SELECT message_id, type, content, data, tool_call_id, tool_kind, attachment_id
                    FROM message_parts
                    ORDER BY message_id, sort_order
                `
                )
                .all();
            expect(parts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        message_id: 1,
                        type: 'tool_call',
                        content: '',
                        tool_call_id: 'call-1',
                        tool_kind: 'builtin',
                    }),
                    expect.objectContaining({
                        message_id: 1,
                        type: 'attachment',
                        content: '',
                        attachment_id: 1,
                    }),
                ])
            );
            expect(
                db
                    .prepare(
                        'SELECT type, content, tool_call_id, tool_kind FROM message_parts WHERE message_id = 2'
                    )
                    .all()
            ).toEqual([
                {
                    type: 'tool_result',
                    content: 'hi result',
                    tool_call_id: 'call-1',
                    tool_kind: 'builtin',
                },
            ]);
            const toolData = db
                .prepare(
                    "SELECT data FROM message_parts WHERE type = 'tool_call' AND tool_call_id = 'call-1'"
                )
                .get()?.data;
            expect(JSON.parse(String(toolData))).toMatchObject({
                tool_id: 'shell',
                iteration: 2,
                input: '{"command":"echo hi"}',
                output: '{"stdout":"hi"}',
                status: 'completed',
                approval_state: 'approved',
                duration_ms: 42,
            });
            expect(
                db
                    .prepare(
                        "SELECT count(*) AS count FROM message_parts WHERE tool_call_id = 'orphan-call'"
                    )
                    .get()?.count
            ).toBe(1);
            expect(
                db.prepare('SELECT count(*) AS count FROM messages WHERE session_id = 1').get()
                    ?.count
            ).toBe(3);
            expect(
                db
                    .prepare(
                        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('message_attachments', 'mcp_tool_logs', 'built_in_tool_logs')"
                    )
                    .get()?.count
            ).toBe(0);
        } finally {
            db.close();
        }
    });
});
