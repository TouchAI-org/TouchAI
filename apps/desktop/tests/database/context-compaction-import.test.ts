import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSessionTransportMessages } from '@/services/AgentService/session/transport';

import { closeTestDatabases, openMigratedDatabase, routeQueriesTo } from './sqliteHarness';

function sourceDatabase() {
    const database = openMigratedDatabase();
    database.exec(`
        INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'import-context', 'Context', 'test');
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'user'), (2, 1, 'assistant'), (3, 1, 'user'), (4, 1, 'assistant');
        UPDATE messages SET created_at='2026-01-01 00:00:00', updated_at='2026-01-01 00:00:00';
        INSERT INTO message_parts (message_id, type, content, sort_order) VALUES
            (1, 'text', 'Old request', 0), (2, 'text', 'Verified old result', 0), (3, 'text', 'Current request', 0);
    `);
    database
        .prepare(
            "INSERT INTO message_parts (message_id, type, content, data, sort_order) VALUES (4, 'context_compaction', 'Verified previous work.', ?, 0)"
        )
        .run(
            JSON.stringify({
                version: 2,
                id: '00000000-0000-4000-8000-000000000001',
                firstKeptMessageId: 3,
                systemMessageIds: [],
                model: 'test',
                createdAt: 100,
                tokensBefore: 5000,
                tokensAfter: 200,
            })
        );
    return database;
}

function attachSource(target: DatabaseSync, source: DatabaseSync) {
    target.exec("ATTACH DATABASE ':memory:' AS imported");
    target.exec('PRAGMA foreign_keys=OFF');
    const tables = source
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_search_fts%'"
        )
        .all();
    for (const table of tables) {
        target.exec(String(table.sql).replace('CREATE TABLE ', 'CREATE TABLE imported.'));
        const columns = source
            .prepare(`PRAGMA table_xinfo("${table.name}")`)
            .all()
            .filter((column) => column.hidden === 0)
            .map((column) => String(column.name));
        const quoted = columns.map((column) => `"${column}"`).join(',');
        const insert = target.prepare(
            `INSERT INTO imported."${table.name}" (${quoted}) VALUES (${columns.map(() => '?').join(',')})`
        );
        for (const row of source.prepare(`SELECT ${quoted} FROM "${table.name}"`).all())
            insert.run(...columns.map((column) => row[column] as SQLInputValue));
    }
    target.exec('PRAGMA foreign_keys=ON');
}

function merge(target: DatabaseSync) {
    target.exec('BEGIN IMMEDIATE');
    target.exec(readFileSync(resolve('src/database/artifacts/import/chat_merge.sql'), 'utf8'));
    target.exec('COMMIT');
}

function saved(target: DatabaseSync) {
    const row = target
        .prepare("SELECT data FROM message_parts WHERE type='context_compaction' ORDER BY id DESC")
        .get()!;
    return JSON.parse(String(row.data)) as {
        firstKeptMessageId: number;
        invalidatedAt?: number;
    };
}

describe('given context checkpoints in a conversation backup', () => {
    afterEach(closeTestDatabases);

    it('user imports rejected calls and preserves opaque or missing-server names while remapping known servers', async () => {
        const source = sourceDatabase();
        source.exec(`
            DELETE FROM message_parts WHERE message_id IN (2, 4);
            UPDATE messages SET role='tool_call' WHERE id=2;
            INSERT INTO mcp_servers (id, name, transport_type, enabled)
            VALUES (7, 'Original server', 'stdio', 0);
        `);
        const calls = [
            { toolCallId: 'canonical', server_id: 7, tool_name: 'missing' },
            { toolCallId: 'opaque', server_id: null, tool_name: 'ghost', requestedName: 'ghost' },
            {
                toolCallId: 'absent-server',
                server_id: null,
                tool_name: 'mcp__999__missing',
                requestedName: 'mcp__999__missing',
            },
        ];
        calls.forEach((identity, index) =>
            source
                .prepare(
                    "INSERT INTO message_parts (message_id, type, content, data, sort_order) VALUES (2, 'tool_call', '', ?, ?)"
                )
                .run(
                    JSON.stringify({
                        ...identity,
                        toolKind: 'mcp',
                        input: '{bad',
                        output: 'Call rejected.',
                        status: 'error',
                    }),
                    index
                )
        );
        const target = openMigratedDatabase();
        target.exec(
            "INSERT INTO mcp_servers (id, name, transport_type) VALUES (100, 'Unrelated server', 'stdio')"
        );
        attachSource(target, source);
        merge(target);
        routeQueriesTo(target);
        const restored = await loadSessionTransportMessages({ sessionId: 1 });
        expect(restored.find((message) => message.tool_calls?.length)?.tool_calls).toEqual([
            { id: 'canonical', name: 'mcp__101__missing', arguments: '{bad' },
            { id: 'opaque', name: 'ghost', arguments: '{bad' },
            { id: 'absent-server', name: 'mcp__999__missing', arguments: '{bad' },
        ]);
        expect(restored.filter((message) => message.role === 'tool')).toHaveLength(3);
        merge(target);
        expect(await loadSessionTransportMessages({ sessionId: 1 })).toEqual(restored);
        expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('user imports into a populated database and reuses remapped checkpoints after repeated identical imports', async () => {
        const source = sourceDatabase();
        const target = openMigratedDatabase();
        target.exec(
            "INSERT INTO sessions(id, session_id, title, model) VALUES (10, 'other', 'Other', 'test'); INSERT INTO messages(id, session_id, role) VALUES (100, 10, 'user');"
        );
        attachSource(target, source);
        merge(target);
        expect(saved(target)).toMatchObject({ firstKeptMessageId: 103 });
        expect(saved(target).invalidatedAt).toBeUndefined();
        merge(target);
        expect(saved(target).invalidatedAt).toBeUndefined();
        routeQueriesTo(target);
        const sessionId = Number(
            target.prepare("SELECT id FROM sessions WHERE session_id='import-context'").get()!.id
        );
        const restored = await loadSessionTransportMessages({ sessionId });
        expect(restored.map((message) => message.content)).toEqual([
            expect.stringContaining('Verified previous work.'),
            'Current request',
        ]);
        expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });

    it('user imports divergent covered history and keeps the divider without accepting the stale summary', () => {
        const source = sourceDatabase();
        const target = sourceDatabase();
        target.exec(
            "UPDATE message_parts SET content='Locally corrected evidence' WHERE message_id=2"
        );
        attachSource(target, source);
        merge(target);
        expect(saved(target).invalidatedAt).toBeTypeOf('number');
        expect(
            target
                .prepare("SELECT content FROM message_parts WHERE type='context_compaction'")
                .get()?.content
        ).toBe('Verified previous work.');
    });

    it('user imports a missing covered message after the retained range and invalidates the reordered checkpoint', () => {
        const source = sourceDatabase();
        const target = sourceDatabase();
        target.exec('DELETE FROM messages WHERE id=2');
        attachSource(target, source);
        merge(target);
        expect(saved(target).invalidatedAt).toBeTypeOf('number');
    });

    it('user imports a checkpoint with an absent boundary and preserves it only as historical evidence', () => {
        const source = sourceDatabase();
        source.exec(
            "UPDATE message_parts SET data=json_set(data, '$.firstKeptMessageId', 999) WHERE type='context_compaction'"
        );
        const target = openMigratedDatabase();
        attachSource(target, source);
        merge(target);
        expect(saved(target).invalidatedAt).toBeTypeOf('number');
    });

    it.each(["'$.firstKeptMessageId', 5", "'$.systemMessageIds', json('[1]')"])(
        'user imports inconsistent checkpoint references (%s) and retains only historical evidence',
        (patch) => {
            const source = sourceDatabase();
            source.exec("INSERT INTO messages(id, session_id, role) VALUES (5, 1, 'user')");
            source.exec(
                `UPDATE message_parts SET data=json_set(data, ${patch}) WHERE type='context_compaction'`
            );
            const target = openMigratedDatabase();
            attachSource(target, source);
            merge(target);
            expect(saved(target).invalidatedAt).toBeTypeOf('number');
        }
    );

    it('user imports a suffix without its covered prefix and invalidates the existing local checkpoint', () => {
        const source = sourceDatabase();
        source.exec('DELETE FROM messages WHERE id IN (1, 2)');
        const target = sourceDatabase();
        attachSource(target, source);
        merge(target);
        expect(saved(target).invalidatedAt).toBeTypeOf('number');
    });

    it('user imports a checkpoint already invalidated locally and cannot resurrect it', () => {
        const source = sourceDatabase();
        const target = sourceDatabase();
        target.exec(
            "UPDATE message_parts SET data=json_set(data, '$.invalidatedAt', 500) WHERE type='context_compaction'"
        );
        attachSource(target, source);
        merge(target);
        expect(saved(target).invalidatedAt).toBe(500);
    });
});
