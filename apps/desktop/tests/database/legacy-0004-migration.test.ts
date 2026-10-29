import { describe, expect, it } from 'vitest';

import { applyMigrationsAfter, createMigrationFixtureDatabase } from './utils/migrations';

const LEGACY_TAG = '0003_tough_amazoness';
const BULK_MESSAGE_COUNT = 10000;

function seedLegacyDatabase(db: ReturnType<typeof createMigrationFixtureDatabase>) {
    db.exec(`
        INSERT INTO sessions (id, session_id, title, model, message_count, created_at, updated_at)
        VALUES (1, 'legacy-fixture', 'Legacy fixture', 'test-model', 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00');

        INSERT INTO attachments (id, hash, type, original_name, origin_path, created_at)
        VALUES (1, 'hash-1', 'image', 'photo.png', '/tmp/photo.png', '2026-01-01 00:00:00');

        INSERT INTO mcp_servers (id, name, transport_type, enabled, tool_timeout, created_at, updated_at)
        VALUES
            (7, 'server-7', 'stdio', 1, 30000, '2026-01-01 00:00:00', '2026-01-01 00:00:00'),
            (8, 'server-8', 'stdio', 1, 30000, '2026-01-01 00:00:00', '2026-01-01 00:00:00');

        INSERT INTO messages (id, session_id, role, content, reasoning, created_at, updated_at)
        VALUES
            (1, 1, 'user', 'hello legacy', NULL, '2026-01-01 00:00:01', '2026-01-01 00:00:01'),
            (2, 1, 'assistant', 'answer with thought', 'reasoning body', '2026-01-01 00:00:02', '2026-01-01 00:00:02'),
            (3, 1, 'tool_result', 'orphan result text', NULL, '2026-01-01 00:00:03', '2026-01-01 00:00:03'),
            (4, 1, 'tool_call', '', NULL, '2026-01-01 00:00:04', '2026-01-01 00:00:04');

        UPDATE messages SET tool_log_id = 1, tool_log_kind = 'mcp' WHERE id = 4;

        INSERT INTO mcp_tool_logs (id, server_id, tool_name, tool_call_id, session_id, message_id, iteration, input, output, status, duration_ms, created_at)
        VALUES
            (1, 7, 'search_docs', 'call-mcp-1', 1, NULL, 0, '{"q":"legacy"}', 'mcp output', 'success', 12, '2026-01-01 00:00:04'),
            (2, 8, 'orphan_tool', 'call-mcp-2', NULL, NULL, 0, '{}', 'orphan output', 'success', 5, '2026-01-01 00:00:05');

        INSERT INTO built_in_tool_logs (id, tool_id, tool_call_id, session_id, message_id, iteration, input, output, status, approval_state, created_at)
        VALUES (1, 'bash', 'call-builtin-1', NULL, NULL, 0, '{}', 'builtin output', 'success', 'approved', '2026-01-01 00:00:06');

        INSERT INTO message_attachments (id, message_id, attachment_id, sort_order, origin_path, created_at)
        VALUES (1, 1, 1, 0, '/tmp/photo.png', '2026-01-01 00:00:01');
    `);

    const insertBulk = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, reasoning, created_at, updated_at)
         VALUES (?, 1, ?, ?, NULL, '2026-02-01 00:00:00', '2026-02-01 00:00:00')`
    );
    db.exec('BEGIN');
    try {
        for (let index = 0; index < BULK_MESSAGE_COUNT; index += 1) {
            const id = 1000 + index;
            insertBulk.run(id, index % 2 === 0 ? 'user' : 'assistant', `bulk message ${index}`);
        }
    } finally {
        db.exec('COMMIT');
    }
}

function tableExists(db: ReturnType<typeof createMigrationFixtureDatabase>, name: string): boolean {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    return Boolean(row);
}

function count(db: ReturnType<typeof createMigrationFixtureDatabase>, sql: string): number {
    const row = db.prepare(sql).get() as { value: number };
    return Number(row.value);
}

describe('legacy 0004 message-parts migration', () => {
    it('migrates a large legacy conversation set without losing parts or tool logs', () => {
        const db = createMigrationFixtureDatabase(LEGACY_TAG);
        try {
            seedLegacyDatabase(db);

            const startedAt = performance.now();
            applyMigrationsAfter(db, LEGACY_TAG);
            const elapsedMs = performance.now() - startedAt;
            // 记录升级耗时（10 万行夹具可复用同一路径放大）。
            console.info(
                `[perf] 0004 migration over ${BULK_MESSAGE_COUNT + 4} messages: ${elapsedMs.toFixed(1)}ms`
            );

            // reasoning 在 text 之前，两者都来自旧列迁移。
            const messageTwoParts = db
                .prepare('SELECT type FROM message_parts WHERE message_id = 2 ORDER BY sort_order')
                .all() as { type: string }[];
            expect(messageTwoParts.map((part) => part.type)).toEqual(['reasoning', 'text']);

            // 无法匹配的 legacy tool_result 保留为 assistant 文本，而不是被静默删除。
            const toolResult = db.prepare('SELECT role FROM messages WHERE id = 3').get() as
                | { role: string }
                | undefined;
            expect(toolResult?.role).toBe('assistant');

            // 每个旧日志都对应一个 tool_call part（2 条 MCP + 1 条内置）。
            expect(
                count(db, "SELECT COUNT(*) AS value FROM message_parts WHERE type = 'tool_call'")
            ).toBe(3);
            const mcpCall = db
                .prepare(
                    "SELECT data FROM message_parts WHERE type = 'tool_call' AND json_extract(data, '$.tool_name') = 'search_docs'"
                )
                .get() as { data: string } | undefined;
            expect(JSON.parse(mcpCall!.data)).toMatchObject({
                server_id: 7,
                tool_name: 'search_docs',
                output: 'mcp output',
                status: 'success',
                toolCallId: 'call-mcp-1',
                toolKind: 'mcp',
            });

            // 旧附件关系转成 attachment part。
            const attachmentPart = db
                .prepare(
                    "SELECT attachment_id FROM message_parts WHERE message_id = 1 AND type = 'attachment'"
                )
                .get() as { attachment_id: number } | undefined;
            expect(attachmentPart?.attachment_id).toBe(1);

            // 旧表在迁移后被移除。
            expect(tableExists(db, 'mcp_tool_logs')).toBe(false);
            expect(tableExists(db, 'built_in_tool_logs')).toBe(false);
            expect(tableExists(db, 'message_attachments')).toBe(false);

            // 旧内容列不再存在。
            const messageColumns = (
                db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
            ).map((column) => column.name);
            expect(messageColumns).not.toContain('content');
            expect(messageColumns).not.toContain('reasoning');

            // 搜索索引对迁移后的正文可见（trigram detail=none 只支持单个三字组）。
            expect(
                count(
                    db,
                    'SELECT COUNT(*) AS value FROM message_search_fts WHERE message_search_fts MATCH \'"ans"\''
                )
            ).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });
});
