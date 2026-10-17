import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import {
    createMessageAttachment,
    findAttachmentsByMessageIds,
} from '@database/queries/attachments';
import { getMessageText, syncOutputParts } from '@database/queries/messageParts';
import { findMessagesBySessionId } from '@database/queries/messages';
import { listSessions, refreshSessionMetadata } from '@database/queries/sessions';
import { createToolPart, findToolParts, updateToolPart } from '@database/queries/toolParts';
import { messageParts } from '@database/schema';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');
const databaseRoot = resolve('src/database');
const journal = JSON.parse(readFileSync(`${databaseRoot}/drizzle/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
};
const databases: SqliteDatabase[] = [];
function openDatabase(entryCount = journal.entries.length) {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    const entries = journal.entries.slice(0, entryCount);
    for (const entry of entries) {
        database.exec(readFileSync(`${databaseRoot}/drizzle/${entry.tag}.sql`, 'utf8'));
    }
    return database;
}
function attachImportDatabase(database: SqliteDatabase) {
    database.exec("ATTACH DATABASE ':memory:' AS imported");
    const tables = database
        .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_search_fts%'"
        )
        .all();
    for (const table of tables) {
        database.exec(String(table.sql).replace('CREATE TABLE ', 'CREATE TABLE imported.'));
    }
}
function routeQueriesTo(database: SqliteDatabase) {
    interceptTauriInvoke((call) => {
        if (call.cmd === 'database_tx_begin') {
            database.exec('BEGIN');
            return 'test-tx';
        }
        if (call.cmd === 'database_tx_commit') {
            database.exec('COMMIT');
            return null;
        }
        if (call.cmd === 'database_tx_rollback') {
            database.exec('ROLLBACK');
            return null;
        }
        if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') return undefined;
        const { request } = call.payload as {
            request: { sql: string; params: SQLInputValue[]; method: string };
        };
        const statement = database.prepare(request.sql);
        if (request.method === 'run') {
            const result = statement.run(...request.params);
            return {
                rows: [],
                rowsAffected: Number(result.changes),
                lastInsertId: Number(result.lastInsertRowid),
            };
        }
        return { rows: statement.all(...request.params), rowsAffected: 0, lastInsertId: null };
    });
}
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function ftsIds(database: SqliteDatabase, value: string): number[] {
    const token = Array.from(value).slice(0, 3).join('');
    return database
        .prepare(
            'SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ? ORDER BY rowid'
        )
        .all('"' + token.replace(/"/g, '""') + '"')
        .map((row) => Number(row.rowid));
}
function seedSearch(database: SqliteDatabase) {
    database.exec(`
        INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'search', 'Conversation', 'test');
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant'), (2, 1, 'assistant');
        INSERT INTO message_parts (message_id, type, content, sort_order) VALUES
            (1, 'text', 'First ', 0), (1, 'reasoning', 'Secret thought', 1), (1, 'text', 'answer', 2);
    `);
}

describe('normalized message parts database contract', () => {
    it('writes and patches tool identifiers only inside data through Drizzle', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        const created = await createToolPart('builtin', {
            message_id: 1,
            tool_call_id: 'call-original',
            tool_id: 'shell',
            input: '{}',
        });
        const savedData = () =>
            JSON.parse(
                String(
                    database.prepare("SELECT data FROM message_parts WHERE type='tool_call'").get()
                        ?.data
                )
            );
        expect(savedData()).toMatchObject({
            toolCallId: 'call-original',
            toolKind: 'builtin',
            status: 'pending',
        });
        const updated = await updateToolPart('builtin', eq(messageParts.id, created.id), {
            tool_call_id: 'call-renamed',
            status: 'success',
            output: 'result',
        });
        expect(updated?.tool_call_id).toBe('call-renamed');
        expect(savedData()).toMatchObject({
            toolCallId: 'call-renamed',
            toolKind: 'builtin',
            output: 'result',
        });
        expect(
            await findToolParts('builtin', eq(messageParts.tool_call_id, 'call-original'))
        ).toEqual([]);
        expect(
            await findToolParts('builtin', eq(messageParts.tool_call_id, 'call-renamed'))
        ).toHaveLength(1);
        const writes = getTauriInvokeCalls('database_tx_query')
            .map((call) => (call.payload as { request: { sql: string } }).request.sql)
            .filter((sql) => /^(insert|update)/i.test(sql));
        for (const sql of writes) {
            const assignment = sql.split(/returning/i)[0]!;
            expect(assignment).not.toMatch(/"(tool_call_id|tool_kind|attachment_id)"/);
        }
    });

    it('updates tool state without moving the part or changing its creation time', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        const created = await createToolPart('builtin', {
            message_id: 1,
            tool_call_id: 'owned-call',
            tool_id: 'shell',
            input: '{}',
            created_at: '2026-10-01 00:00:00',
        });
        const patch = {
            status: 'success' as const,
            output: 'Done',
            message_id: 2,
            created_at: '2026-10-02 00:00:00',
        };
        const updated = await updateToolPart('builtin', eq(messageParts.id, created.id), patch);
        expect(updated).toMatchObject({
            id: created.id,
            message_id: 1,
            created_at: '2026-10-01 00:00:00',
            status: 'success',
            output: 'Done',
        });
    });

    it('writes an attachment reference in data and joins through its virtual column', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        database.exec(
            "INSERT INTO attachments (id, hash, type, original_name, origin_path) VALUES (7, 'file-hash', 'file', 'test.txt', '/cache/file.txt')"
        );
        await createMessageAttachment({
            message_id: 1,
            attachment_id: 7,
            origin_path: '/original/file.txt',
        });
        const part = database
            .prepare("SELECT data, attachment_id FROM message_parts WHERE type='attachment'")
            .get()!;
        expect(JSON.parse(String(part.data))).toEqual({
            attachmentId: 7,
            originPath: '/original/file.txt',
        });
        expect(part.attachment_id).toBe(7);
        expect(await findAttachmentsByMessageIds([1])).toMatchObject([
            { id: 7, origin_path: '/original/file.txt', message_id: 1 },
        ]);
    });

    it('searches canonical tool outputs and keeps their FTS row in sync', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        database.exec(
            "UPDATE messages SET role = 'tool_call' WHERE id = 2;" +
                'INSERT INTO message_parts (message_id, type, content, data, sort_order) VALUES (2, \'tool_call\', \'\', \'{"toolCallId":"call-1","toolKind":"builtin","output":"Tool output needle"}\', 0)'
        );
        expect(await listSessions({ query: 'output needle' })).toHaveLength(1);
        expect(await listSessions({ query: 'needle' })).toHaveLength(1);
        expect(await listSessions({ query: 'To' })).toHaveLength(1);
        database.exec(
            "UPDATE message_parts SET data = json_set(data, '$.output', 'Replacement result') WHERE message_id = 2"
        );
        expect(await listSessions({ query: 'needle' })).toHaveLength(0);
        expect(await listSessions({ query: 'Replacement' })).toHaveLength(1);
        database.exec('DELETE FROM message_parts WHERE message_id = 2');
        expect(ftsIds(database, 'Replacement')).toEqual([]);
    });
    it('updates output parts in place without rewriting tool or attachment parts', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        database.exec(
            "INSERT INTO attachments (id, hash, type, original_name, origin_path) VALUES (7, 'file-hash', 'file', 'test.txt', '/cache/file.txt');" +
                "INSERT INTO message_parts (message_id, type, content, data, sort_order) VALUES (1, 'tool_call', '', '{}', 3), (1, 'attachment', '', '{\"attachmentId\":7}', 4)"
        );
        const original = database
            .prepare('SELECT * FROM message_parts WHERE message_id = 1 ORDER BY sort_order')
            .all();
        const drafts = [
            { message_id: 1, type: 'text' as const, content: 'First ', sort_order: 0 },
            {
                message_id: 1,
                type: 'reasoning' as const,
                content: 'Updated plan',
                sort_order: 1,
                started_at: 1000,
                ended_at: 3000,
            },
            { message_id: 1, type: 'text' as const, content: 'New answer', sort_order: 2 },
        ];
        await syncOutputParts(1, drafts);
        const updated = database
            .prepare('SELECT * FROM message_parts WHERE message_id = 1 ORDER BY sort_order')
            .all();
        expect(updated.map((part) => part.id)).toEqual(original.map((part) => part.id));
        expect(updated[0]).toEqual(original[0]);
        expect(updated.slice(3)).toEqual(original.slice(3));
        expect(ftsIds(database, 'New answer')).toEqual([1]);
        expect(ftsIds(database, 'Updated plan')).toEqual([]);
        const start = getTauriInvokeCalls('database_query').length;
        await syncOutputParts(1, drafts);
        const queries = getTauriInvokeCalls('database_query').slice(start);
        expect(
            queries.filter((call) =>
                /^(insert|update)/i.test((call.payload as { request: { sql: string } }).request.sql)
            )
        ).toEqual([]);
        await syncOutputParts(1, []);
        expect(
            database
                .prepare('SELECT type FROM message_parts WHERE message_id = 1 ORDER BY sort_order')
                .all()
        ).toEqual([{ type: 'tool_call' }, { type: 'attachment' }]);
        expect(ftsIds(database, 'New answer')).toEqual([]);
    });

    it('stores message content only in parts', () => {
        const database = openDatabase();
        const columns = database.prepare('PRAGMA table_info(messages)').all();
        expect(columns.map((column) => column.name)).not.toContain('content');
        expect(columns.map((column) => column.name)).not.toContain('reasoning');
    });
    it('preserves legacy content and reasoning and backfills the index', () => {
        const database = openDatabase(4);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'migration', 'Migration', 'test');
            INSERT INTO messages (id, session_id, role, content, reasoning) VALUES (1, 1, 'assistant', 'Existing answer', 'Existing thought');
        `);
        for (const entry of journal.entries.slice(4)) {
            database.exec(readFileSync(`${databaseRoot}/drizzle/${entry.tag}.sql`, 'utf8'));
        }
        expect(
            database
                .prepare('SELECT type, content, sort_order FROM message_parts ORDER BY sort_order')
                .all()
        ).toEqual([
            { type: 'reasoning', content: 'Existing thought', sort_order: 0 },
            { type: 'text', content: 'Existing answer', sort_order: 1 },
        ]);
        expect(ftsIds(database, 'Existing answer')).toEqual([1]);
        expect(ftsIds(database, 'thought')).toEqual([]);
    });
    it('cascades message deletion to its parts and search index row', () => {
        const database = openDatabase();
        seedSearch(database);
        database.exec('DELETE FROM messages WHERE id = 1');
        expect(database.prepare('SELECT COUNT(*) AS count FROM message_parts').get()?.count).toBe(
            0
        );
        expect(ftsIds(database, 'First')).toEqual([]);
    });
    it('imports ordered parts once and preserves reasoning timing and search', () => {
        const database = openDatabase();
        database.exec("ATTACH DATABASE ':memory:' AS imported");
        const tables = database
            .prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_search_fts%'"
            )
            .all();
        for (const table of tables)
            database.exec(String(table.sql).replace('CREATE TABLE ', 'CREATE TABLE imported.'));
        database.exec(`
            INSERT INTO imported.sessions (id, session_id, title, model) VALUES (1, 'import', 'Import', 'test');
            INSERT INTO imported.messages (id, session_id, role) VALUES (1, 1, 'assistant');
            INSERT INTO imported.message_parts (message_id, type, content, sort_order, started_at, ended_at) VALUES
                (1, 'reasoning', 'First thought', 0, 1000, 2000),
                (1, 'text', 'Middle', 1, NULL, NULL),
                (1, 'reasoning', 'Second thought', 2, 3000, 4000),
                (1, 'text', 'Answer', 3, NULL, NULL);
        `);
        const merge = readFileSync(`${databaseRoot}/artifacts/import/chat_merge.sql`, 'utf8');
        database.exec(merge);
        database.exec(merge);
        expect(
            database
                .prepare(
                    'SELECT type, content, sort_order, started_at, ended_at FROM main.message_parts ORDER BY sort_order'
                )
                .all()
        ).toEqual([
            {
                type: 'reasoning',
                content: 'First thought',
                sort_order: 0,
                started_at: 1000,
                ended_at: 2000,
            },
            { type: 'text', content: 'Middle', sort_order: 1, started_at: null, ended_at: null },
            {
                type: 'reasoning',
                content: 'Second thought',
                sort_order: 2,
                started_at: 3000,
                ended_at: 4000,
            },
            { type: 'text', content: 'Answer', sort_order: 3, started_at: null, ended_at: null },
        ]);
        expect(database.prepare('SELECT count(*) AS count FROM main.messages').get()?.count).toBe(
            1
        );
        expect(ftsIds(database, 'MiddleAnswer')).toEqual([1]);
        expect(ftsIds(database, 'thought')).toEqual([]);
        expect(
            database.prepare('SELECT count(*) AS count FROM message_search_fts').get()?.count
        ).toBe(1);
    });
    it('completes and updates an imported message without replacing existing part IDs', () => {
        const database = openDatabase();
        attachImportDatabase(database);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (9, 'partial', 'Partial', 'test');
            INSERT INTO messages (id, session_id, role, created_at) VALUES (10, 9, 'assistant', '2026-10-01 00:00:00');
            INSERT INTO message_parts (id, message_id, type, content, sort_order) VALUES (20, 10, 'reasoning', 'Partial plan', 0);
            INSERT INTO imported.sessions (id, session_id, title, model) VALUES (1, 'partial', 'Full', 'test');
            INSERT INTO imported.messages (id, session_id, role, created_at) VALUES (1, 1, 'assistant', '2026-10-01 00:00:00');
            INSERT INTO imported.message_parts (message_id, type, content, sort_order) VALUES
                (1, 'reasoning', 'Complete plan', 0), (1, 'text', 'Answer', 1);
        `);
        const merge = readFileSync(`${databaseRoot}/artifacts/import/chat_merge.sql`, 'utf8');
        database.exec(merge);
        expect(database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 10 }]);
        const answerId = Number(
            database.prepare("SELECT id FROM message_parts WHERE type='text'").get()?.id
        );
        expect(answerId).toBeGreaterThan(20);
        expect(
            database
                .prepare('SELECT id, type, content FROM message_parts ORDER BY sort_order')
                .all()
        ).toEqual([
            { id: 20, type: 'reasoning', content: 'Complete plan' },
            { id: answerId, type: 'text', content: 'Answer' },
        ]);
        database.exec(
            "UPDATE imported.message_parts SET content='Revised answer' WHERE type='text'"
        );
        database.exec(merge);
        expect(database.prepare('SELECT id FROM messages').all()).toEqual([{ id: 10 }]);
        expect(
            database.prepare("SELECT id, content FROM message_parts WHERE type='text'").get()
        ).toEqual({ id: answerId, content: 'Revised answer' });
        expect(ftsIds(database, 'Revised answer')).toEqual([10]);
        database.exec("DELETE FROM imported.message_parts WHERE type='text'");
        database.exec(merge);
        expect(database.prepare('SELECT id FROM message_parts').all()).toEqual([{ id: 20 }]);
        expect(ftsIds(database, 'Revised answer')).toEqual([]);
    });

    it('keeps chat-only turns and MCP identities when local IDs differ without copying secrets', () => {
        const database = openDatabase();
        attachImportDatabase(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (1, 'Local', 'openai', 'http://local', '');
            INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Local', 'local-model');
            INSERT INTO mcp_servers (id, name, transport_type) VALUES (1, 'Local MCP', 'stdio');
            INSERT INTO imported.providers (id, name, driver, api_endpoint, logo, api_key, config_json) VALUES
                (1, 'Source', 'openai', 'http://source', '', 'secret', '{"token":"secret"}');
            INSERT INTO imported.models (id, provider_id, name, model_id, is_default) VALUES (1, 1, 'Source', 'source-model', 1);
            INSERT INTO imported.mcp_servers (id, name, transport_type, command, env) VALUES (1, 'Source MCP', 'stdio', 'command', '{"TOKEN":"secret"}');
            INSERT INTO imported.sessions (id, session_id, title, model, provider_id) VALUES (1, 'identity', 'Test', 'source-model', 1);
            INSERT INTO imported.messages (id, session_id, role) VALUES (1, 1, 'tool_call');
            INSERT INTO imported.message_parts (message_id, type, content, data, sort_order) VALUES
                (1, 'tool_call', '', '{"toolCallId":"call","toolKind":"mcp","server_id":1,"tool_name":"test","input":"{}"}', 0);
            INSERT INTO imported.session_turns (id, session_id, model_id, task_id, prompt_snapshot_json) VALUES (1, 1, 1, 'task', '{}'), (2, NULL, 1, 'deleted-session-task', '{}');
            INSERT INTO imported.session_turn_attempts (turn_id, attempt_index, checkpoint_json, delivery_manifest_json) VALUES (1, 1, '{"activeModelId":1}', '{"version":1,"requests":[]}');
        `);
        const merge = readFileSync(`${databaseRoot}/artifacts/import/chat_merge.sql`, 'utf8');
        database.exec(merge);
        database.exec(merge);
        expect(
            database
                .prepare(
                    "SELECT id, api_key, config_json, enabled FROM providers WHERE name='Source'"
                )
                .get()
        ).toEqual({ id: 2, api_key: null, config_json: null, enabled: 0 });
        expect(
            database
                .prepare("SELECT provider_id, is_default FROM models WHERE model_id='source-model'")
                .get()
        ).toEqual({ provider_id: 2, is_default: 0 });
        expect(
            database
                .prepare(
                    "SELECT id, command, env, enabled FROM mcp_servers WHERE name='Source MCP'"
                )
                .get()
        ).toEqual({ id: 2, command: null, env: null, enabled: 0 });
        expect(
            database
                .prepare("SELECT json_extract(data, '$.server_id') AS server_id FROM message_parts")
                .get()
        ).toEqual({ server_id: 2 });
        expect(database.prepare('SELECT model_id FROM session_turns ORDER BY id').all()).toEqual([
            { model_id: 2 },
            { model_id: 2 },
        ]);
        expect(
            database.prepare('SELECT COUNT(*) AS count FROM session_turn_attempts').get()?.count
        ).toBe(1);
        expect(
            JSON.parse(
                String(
                    database.prepare('SELECT checkpoint_json FROM session_turn_attempts').get()
                        ?.checkpoint_json
                )
            ).activeModelId
        ).toBe(2);
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('does not bind imported historical tools to an unrelated local server after source deletion', () => {
        const database = openDatabase();
        attachImportDatabase(database);
        database.exec(`
            INSERT INTO mcp_servers (id, name, transport_type) VALUES (1, 'Unrelated local server', 'stdio');
            INSERT INTO imported.sessions (id, session_id, title, model) VALUES (1, 'orphan-tool', 'History', 'test');
            INSERT INTO imported.messages (id, session_id, role) VALUES (1, 1, 'tool_call');
            INSERT INTO imported.message_parts (message_id, type, content, data, sort_order)
            VALUES (1, 'tool_call', '', '{"toolKind":"mcp","toolCallId":"historical-call","server_id":1,"tool_name":"lookup","input":"{}","output":"Historical result","status":"success"}', 0);
        `);
        const merge = readFileSync(`${databaseRoot}/artifacts/import/chat_merge.sql`, 'utf8');
        database.exec(merge);
        database.exec(merge);
        const data = JSON.parse(
            String(
                database.prepare("SELECT data FROM message_parts WHERE type='tool_call'").get()
                    ?.data
            )
        );
        expect(data).toMatchObject({
            server_id: null,
            tool_name: 'lookup',
            output: 'Historical result',
        });
        expect(database.prepare('SELECT count(*) AS count FROM messages').get()?.count).toBe(1);
        expect(database.prepare('SELECT count(*) AS count FROM message_parts').get()?.count).toBe(
            1
        );
        expect(database.prepare('SELECT count(*) AS count FROM mcp_servers').get()?.count).toBe(1);
        expect(
            JSON.parse(
                String(
                    database
                        .prepare("SELECT data FROM imported.message_parts WHERE type='tool_call'")
                        .get()?.data
                )
            ).server_id
        ).toBe(1);
    });

    it('merges full settings by provider/model/server identity rather than source row IDs', () => {
        const database = openDatabase();
        attachImportDatabase(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (5, 'Shared', 'openai', 'http://old', '');
            INSERT INTO models (id, provider_id, name, model_id, is_default) VALUES (6, 5, 'Old', 'shared-model', 1);
            INSERT INTO mcp_servers (id, name, transport_type) VALUES (7, 'Shared MCP', 'stdio');
            INSERT INTO mcp_tools (server_id, name, input_schema) VALUES (7, 'test', '{}');
            INSERT INTO imported.providers (id, name, driver, api_endpoint, logo, api_key, enabled) VALUES (1, 'Shared', 'openai', 'http://new', 'new.png', 'new-key', 1);
            INSERT INTO imported.models (id, provider_id, name, model_id, is_default, context_limit) VALUES (1, 1, 'New', 'shared-model', 1, 1000);
            INSERT INTO imported.mcp_servers (id, name, transport_type, command) VALUES (1, 'Shared MCP', 'stdio', 'new-command');
            INSERT INTO imported.mcp_tools (server_id, name, description, input_schema) VALUES (1, 'test', 'New description', '{"type":"object"}');
            INSERT INTO imported.settings (key, value) VALUES ('test', 'new');
        `);
        database.exec(readFileSync(`${databaseRoot}/artifacts/import/full_prelude.sql`, 'utf8'));
        database.exec(readFileSync(`${databaseRoot}/artifacts/import/chat_merge.sql`, 'utf8'));
        expect(database.prepare('SELECT id, api_endpoint, api_key FROM providers').all()).toEqual([
            { id: 5, api_endpoint: 'http://new', api_key: 'new-key' },
        ]);
        expect(
            database
                .prepare('SELECT id, provider_id, name, is_default, context_limit FROM models')
                .all()
        ).toEqual([{ id: 6, provider_id: 5, name: 'New', is_default: 1, context_limit: 1000 }]);
        expect(database.prepare('SELECT id, command FROM mcp_servers').all()).toEqual([
            { id: 7, command: 'new-command' },
        ]);
        expect(database.prepare('SELECT server_id, description FROM mcp_tools').all()).toEqual([
            { server_id: 7, description: 'New description' },
        ]);
        expect(database.prepare("SELECT value FROM settings WHERE key='test'").get()?.value).toBe(
            'new'
        );
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('remaps upgrade-model chain providers while preserving order on repeated full imports', () => {
        const database = openDatabase();
        attachImportDatabase(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES
                (1, 'Unrelated', 'openai', 'http://local', ''),
                (5, 'Shared', 'openai', 'http://shared', ''),
                (8, 'Second', 'openai', 'http://second', '');
            INSERT INTO imported.providers (id, name, driver, api_endpoint, logo) VALUES
                (1, 'Shared', 'openai', 'http://shared', ''),
                (2, 'Second', 'openai', 'http://second', '');
            INSERT INTO imported.built_in_tools (tool_id, display_name, description, risk_level, config_json) VALUES
                ('upgrade_model', 'Upgrade', '', 'low', '{"chain":[{"providerId":2,"modelId":"second-model"},{"providerId":1,"modelId":"shared-model"}]}'),
                ('other_tool', 'Other', '', 'low', '{"chain":[{"providerId":1,"modelId":"unchanged"}]}');
        `);
        const fullPrelude = readFileSync(
            `${databaseRoot}/artifacts/import/full_prelude.sql`,
            'utf8'
        );
        for (let index = 0; index < 2; index++) {
            database.exec(fullPrelude);
            expect(
                JSON.parse(
                    String(
                        database
                            .prepare(
                                "SELECT config_json FROM built_in_tools WHERE tool_id='upgrade_model'"
                            )
                            .get()?.config_json
                    )
                )
            ).toEqual({
                chain: [
                    { providerId: 8, modelId: 'second-model' },
                    { providerId: 5, modelId: 'shared-model' },
                ],
            });
            expect(
                database
                    .prepare("SELECT config_json FROM built_in_tools WHERE tool_id='other_tool'")
                    .get()?.config_json
            ).toBe('{"chain":[{"providerId":1,"modelId":"unchanged"}]}');
        }
        expect(
            JSON.parse(
                String(
                    database
                        .prepare(
                            "SELECT config_json FROM imported.built_in_tools WHERE tool_id='upgrade_model'"
                        )
                        .get()?.config_json
                )
            ).chain[0].providerId
        ).toBe(2);
    });

    it('does not bind removed upgrade-chain providers to unrelated local row IDs', () => {
        const database = openDatabase();
        attachImportDatabase(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (1, 'Unrelated', 'openai', 'http://local', '');
            INSERT INTO imported.built_in_tools (tool_id, display_name, description, risk_level, config_json) VALUES
                ('upgrade_model', 'Upgrade', '', 'low', '{"chain":[{"providerId":1,"modelId":"missing"}]}');
        `);
        database.exec(readFileSync(`${databaseRoot}/artifacts/import/full_prelude.sql`, 'utf8'));
        expect(
            JSON.parse(
                String(
                    database
                        .prepare(
                            "SELECT config_json FROM built_in_tools WHERE tool_id='upgrade_model'"
                        )
                        .get()?.config_json
                )
            )
        ).toEqual({ chain: [] });
    });

    it('releases import workspace tables instead of retaining copied parts on the connection', () => {
        const database = openDatabase();
        attachImportDatabase(database);
        const merge = readFileSync(`${databaseRoot}/artifacts/import/chat_merge.sql`, 'utf8');
        for (let index = 0; index < 2; index++) {
            database.exec(merge);
            expect(
                database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()
            ).toEqual([]);
        }
    });

    it('remaps imported attachment IDs without mutating source parts or duplicating messages', () => {
        const database = openDatabase();
        database.exec(
            "INSERT INTO attachments (id, hash, type, original_name, origin_path) VALUES (2, 'same-hash', 'file', 'local.txt', '/local'), (7, 'other-hash', 'file', 'other.txt', '/other')"
        );
        database.exec("ATTACH DATABASE ':memory:' AS imported");
        const tables = database
            .prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_search_fts%'"
            )
            .all();
        for (const table of tables)
            database.exec(String(table.sql).replace('CREATE TABLE ', 'CREATE TABLE imported.'));
        database.exec(`
            INSERT INTO imported.attachments (id, hash, type, original_name, origin_path)
            VALUES (7, 'same-hash', 'file', 'backup.txt', '/backup');
            INSERT INTO imported.sessions (id, session_id, title, model) VALUES (1, 'import-attachment', 'Import', 'test');
            INSERT INTO imported.messages (id, session_id, role) VALUES (1, 1, 'user');
            INSERT INTO imported.message_parts (message_id, type, content, data, sort_order)
            VALUES (1, 'attachment', '', '{"attachmentId":7,"originPath":"/backup"}', 0);
        `);
        const merge = readFileSync(`${databaseRoot}/artifacts/import/chat_merge.sql`, 'utf8');
        database.exec(merge);
        database.exec(merge);
        expect(
            database
                .prepare(
                    "SELECT attachment_id, data FROM main.message_parts WHERE type = 'attachment'"
                )
                .all()
        ).toEqual([{ attachment_id: 2, data: '{"attachmentId":2,"originPath":"/backup"}' }]);
        expect(
            database
                .prepare("SELECT data FROM imported.message_parts WHERE type = 'attachment'")
                .get()?.data
        ).toBe('{"attachmentId":7,"originPath":"/backup"}');
        expect(database.prepare('SELECT COUNT(*) AS count FROM main.messages').get()?.count).toBe(
            1
        );
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
    it('derives history, previews and substring searches from ordered parts', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        const rows = await findMessagesBySessionId(1);
        expect(getMessageText(rows[0]!.parts)).toBe('First answer');
        expect(rows[0]?.parts.find((part) => part.type === 'reasoning')?.content).toBe(
            'Secret thought'
        );
        expect(rows[0]).not.toHaveProperty('content');
        expect(rows[0]).not.toHaveProperty('reasoning');
        expect(rows[0]?.parts.map((part) => part.type)).toEqual(['text', 'reasoning', 'text']);
        database.exec('DELETE FROM messages WHERE id = 2');
        await refreshSessionMetadata(1);
        expect(
            database.prepare('SELECT last_message_preview FROM sessions').get()
                ?.last_message_preview
        ).toBe('First answer');
        expect(await listSessions({ query: 'First answer' })).toHaveLength(1);
        expect(await listSessions({ query: 'Missing' })).toHaveLength(0);
    });

    it('ignores reasoning-only assistant messages when refreshing session metadata', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model)
            VALUES (1, 'reasoning-only', 'Conversation', 'test');
            INSERT INTO messages (id, session_id, role, created_at) VALUES
                (1, 1, 'assistant', '2026-01-01 00:00:00'),
                (2, 1, 'assistant', '2026-01-02 00:00:00');
            INSERT INTO message_parts (message_id, type, content, sort_order) VALUES
                (1, 'text', 'Visible answer', 0),
                (2, 'reasoning', 'Hidden thought', 0);
        `);

        await refreshSessionMetadata(1);

        expect(
            database
                .prepare('SELECT last_message_preview, last_message_at FROM sessions WHERE id = 1')
                .get()
        ).toEqual({
            last_message_preview: 'Visible answer',
            last_message_at: '2026-01-01 00:00:00',
        });
    });
});

describe('contentless-delete message search index', () => {
    it('indexes the ordered message without a second content table or token positions', () => {
        const database = openDatabase();
        seedSearch(database);
        const definition = String(
            database
                .prepare("SELECT sql FROM sqlite_master WHERE name = 'message_search_fts'")
                .get()?.sql
        );
        expect(definition).toContain('contentless_delete=1');
        expect(definition).toContain('detail=none');
        expect(
            database
                .prepare("SELECT name FROM sqlite_master WHERE name = 'message_search_fts_content'")
                .all()
        ).toEqual([]);
        expect(database.prepare('SELECT rowid, content FROM message_search_fts').all()).toEqual([
            { rowid: 1, content: null },
        ]);
        expect(ftsIds(database, 'First')).toEqual([1]);
        expect(ftsIds(database, 'Secret')).toEqual([]);
    });
    it('synchronizes content, ordering, types, moves, and removal of the last text part', () => {
        const database = openDatabase();
        seedSearch(database);
        database.exec(
            "UPDATE message_parts SET content = 'Changed ' WHERE message_id = 1 AND sort_order = 0"
        );
        expect(ftsIds(database, 'First')).toEqual([]);
        expect(ftsIds(database, 'Changed')).toEqual([1]);
        database.exec(
            "UPDATE message_parts SET sort_order = -1 WHERE message_id = 1 AND content = 'answer'"
        );
        expect(ftsIds(database, 'erC')).toEqual([1]);
        database.exec("UPDATE message_parts SET type = 'reasoning' WHERE content = 'Changed '");
        expect(ftsIds(database, 'Changed')).toEqual([]);
        database.exec("UPDATE message_parts SET message_id = 2 WHERE type = 'text'");
        expect(ftsIds(database, 'answer')).toEqual([2]);
        database.exec('DELETE FROM message_parts WHERE message_id = 2');
        expect(database.prepare('SELECT rowid FROM message_search_fts').all()).toEqual([]);
        database.exec("UPDATE message_parts SET type = 'text' WHERE content = 'Secret thought'");
        expect(ftsIds(database, 'Secret')).toEqual([1]);
    });
    it('can reconstruct the contentless index from parts without another content store', () => {
        const database = openDatabase();
        seedSearch(database);
        database.exec(`
            BEGIN IMMEDIATE;
            INSERT INTO message_search_fts(message_search_fts) VALUES ('delete-all');
            INSERT INTO message_search_fts(rowid, content)
            SELECT message_id, group_concat(content, '')
            FROM (
                SELECT message_id, content FROM message_parts WHERE type = 'text'
                ORDER BY message_id, sort_order, id
            ) GROUP BY message_id;
            INSERT INTO message_search_fts(message_search_fts) VALUES ('integrity-check');
            COMMIT;
        `);
        expect(ftsIds(database, 'First')).toEqual([1]);
        expect(ftsIds(database, 'Secret')).toEqual([]);
        expect(
            database.prepare('SELECT content FROM message_search_fts').get()?.content
        ).toBeNull();
    });

    it('does not rewrite the index for reasoning, timing or unchanged text', () => {
        const database = openDatabase();
        seedSearch(database);
        const changes = () =>
            Number(database.prepare('SELECT total_changes() AS value').get()?.value);
        for (const statement of [
            "UPDATE message_parts SET content = 'New thought' WHERE type = 'reasoning'",
            "UPDATE message_parts SET started_at = 1000, ended_at = 2000 WHERE type = 'reasoning'",
            'UPDATE message_parts SET content = content WHERE sort_order = 0',
        ]) {
            const before = changes();
            database.exec(statement);
            expect(changes() - before).toBe(1);
        }
        expect(ftsIds(database, 'First')).toEqual([1]);
        expect(ftsIds(database, 'New thought')).toEqual([]);
    });

    it('replaces parts atomically and rolls the index back with the source', () => {
        const database = openDatabase();
        seedSearch(database);
        database.exec(`BEGIN; DELETE FROM message_parts WHERE message_id = 1;
            INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (1, 'text', 'Replacement', 0);`);
        expect(ftsIds(database, 'First')).toEqual([]);
        expect(ftsIds(database, 'Replacement')).toEqual([1]);
        database.exec('ROLLBACK');
        expect(ftsIds(database, 'Replacement')).toEqual([]);
        expect(ftsIds(database, 'First')).toEqual([1]);
        database.exec(
            "BEGIN; DELETE FROM message_parts WHERE message_id = 1; INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (1, 'text', 'Committed', 0); COMMIT;"
        );
        expect(ftsIds(database, 'Committed')).toEqual([1]);
    });
    it('removes index rows on message and session cascade deletion', () => {
        const database = openDatabase();
        seedSearch(database);
        database.exec('BEGIN; DELETE FROM messages WHERE id = 1; ROLLBACK;');
        expect(ftsIds(database, 'First')).toEqual([1]);
        database.exec('DELETE FROM messages WHERE id = 1');
        expect(database.prepare('SELECT rowid FROM message_search_fts').all()).toEqual([]);
        database.exec(
            "INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (2, 'text', 'Another', 0); DELETE FROM sessions WHERE id = 1;"
        );
        expect(database.prepare('SELECT rowid FROM message_search_fts').all()).toEqual([]);
    });
    it.each([
        ['First answer', true],
        ['RST ANS', true],
        ['first absent', false],
        ['中文搜索', true],
        ['文搜', true],
        ['中', true],
        ['不存在', false],
        ['100%', true],
        ['_ab', true],
        ['%_ab', false],
        ['a"b', true],
        ['a OR b', true],
        ['NOT', false],
        ['foo*', true],
        ['x\\y', true],
        ['😀中文', true],
        ['😀中', true],
        ['😀', true],
        ['First answer\0ignored', true],
        ['a\u200db', true],
        ['ab\u0301', true],
        ['Secret', false],
        ['résumé', true],
        ['resume', false],
        ['é', true],
    ])('preserves literal substring search for %j', async (query, matches) => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        database
            .prepare(
                "INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (2, 'text', ?, 0)"
            )
            .run('中文搜索 100% _ab a"b a OR b foo* x\\y 😀中文 résumé a\u200db ab\u0301');
        expect(await listSessions({ query })).toHaveLength(matches ? 1 : 0);
    });
    it('uses FTS candidates for long queries, verifies them against text, and falls back for short queries', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        expect(await listSessions({ query: 'First missing' })).toHaveLength(0);
        const requests = () =>
            getTauriInvokeCalls('database_query').map(
                (call) =>
                    (call.payload as { request: { sql: string; params: SQLInputValue[] } }).request
            );
        const longSearch = requests().slice(-1)[0]!;
        expect(longSearch.sql).toContain('message_search_fts');
        expect(longSearch.sql).toContain('"sessions"."id" in (select');
        expect(longSearch.params).toContain('"fir"');
        const plan = database
            .prepare('EXPLAIN QUERY PLAN ' + longSearch.sql)
            .all(...longSearch.params);
        expect(
            plan.some(
                (row) =>
                    String(row.detail).includes('VIRTUAL TABLE INDEX') &&
                    String(row.detail).includes('M')
            )
        ).toBe(true);
        await listSessions({ query: 'Fi' });
        expect(requests().slice(-1)[0]!.sql).not.toContain('message_search_fts');
    });
    it('returns every matching session once and applies the limit after title and content matches', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        database.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES
                (2, 'second', 'Second', 'test'), (3, 'title', 'Needle title', 'test');
            INSERT INTO messages (id, session_id, role) VALUES (3, 2, 'user'), (4, 2, 'assistant');
            INSERT INTO message_parts (message_id, type, content, sort_order) VALUES
                (2, 'text', 'needle one', 0), (3, 'text', 'needle two', 0), (4, 'text', 'needle three', 0);
        `);
        expect((await listSessions({ query: 'needle' })).map((session) => session.id)).toEqual([
            3, 2, 1,
        ]);
        expect(
            (await listSessions({ query: 'needle', limit: 2 })).map((session) => session.id)
        ).toEqual([3, 2]);
    });

    it('keeps title matches, archived sessions and searchable roles intact', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedSearch(database);
        database.exec(
            "UPDATE sessions SET title = 'Only title'; UPDATE messages SET role = 'system';"
        );
        expect(await listSessions({ query: 'Only title' })).toHaveLength(1);
        expect(await listSessions({ query: 'First' })).toHaveLength(0);
        database.exec("UPDATE messages SET role = 'tool_call' WHERE id = 1");
        expect(await listSessions({ query: 'First' })).toHaveLength(1);
        database.exec("UPDATE sessions SET archived_at = datetime('now')");
        expect(await listSessions({ query: 'First' })).toHaveLength(1);
    });
});
