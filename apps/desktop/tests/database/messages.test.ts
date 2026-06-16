import {
    findUnambiguousToolLogByStoredReference,
    type ToolLogHistoryRow,
} from '@database/queries/messages';
import { describe, expect, it } from 'vitest';

const BASE_TIME = '2026-05-31T10:00:00.000Z';

function createToolLog(overrides: Partial<ToolLogHistoryRow>): ToolLogHistoryRow {
    return {
        source: 'builtin',
        log_id: 1,
        tool_call_id: 'call_1',
        tool_name: 'bash',
        tool_input: '{}',
        message_id: 1,
        created_at: BASE_TIME,
        tool_status: 'success',
        tool_duration_ms: 1,
        server_id: null,
        builtin_conversation_semantic_json: null,
        ...overrides,
    };
}

describe('message query tool log references', () => {
    it('does not treat a missing tool log kind as MCP when ids collide across log tables', () => {
        const builtInLog = createToolLog({
            source: 'builtin',
            log_id: 7,
            tool_call_id: 'call_builtin',
        });
        const mcpLog = createToolLog({
            source: 'mcp',
            log_id: 7,
            tool_call_id: 'call_mcp',
            tool_name: 'lookup',
            server_id: 42,
        });
        const toolLogsByIdentity = new Map([
            [`${builtInLog.source}:${builtInLog.log_id}`, builtInLog],
            [`${mcpLog.source}:${mcpLog.log_id}`, mcpLog],
        ]);

        expect(
            findUnambiguousToolLogByStoredReference(toolLogsByIdentity, 7, null)
        ).toBeUndefined();
        expect(findUnambiguousToolLogByStoredReference(toolLogsByIdentity, 7, 'builtin')).toBe(
            builtInLog
        );
        expect(findUnambiguousToolLogByStoredReference(toolLogsByIdentity, 7, 'mcp')).toBe(mcpLog);
    });

    it('keeps legacy references when only one log table has the stored id', () => {
        const builtInLog = createToolLog({
            source: 'builtin',
            log_id: 8,
            tool_call_id: 'call_builtin',
        });
        const toolLogsByIdentity = new Map([
            [`${builtInLog.source}:${builtInLog.log_id}`, builtInLog],
        ]);

        expect(findUnambiguousToolLogByStoredReference(toolLogsByIdentity, 8, null)).toBe(
            builtInLog
        );
    });
});
