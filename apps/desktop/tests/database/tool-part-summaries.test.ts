import {
    findBuiltInToolLogById,
    findBuiltInToolLogSummariesByToolId,
} from '@database/queries/builtInToolLogs';
import {
    findMcpToolLogById,
    findMcpToolLogSummariesByServerId,
} from '@database/queries/mcpToolLogs';
import { getSettingValues } from '@database/queries/settings';
import {
    findToolPartById,
    findToolPartSummaries,
    type ToolPartSummaryRow,
} from '@database/queries/toolParts';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

const CREATED_AT = '2026-05-29T00:00:00.000Z';

function respondWithRows(rows: unknown[]) {
    interceptTauriInvoke((call) =>
        call.cmd === 'database_query' ? { rows, rowsAffected: 0, lastInsertId: null } : undefined
    );
}

function lastSql(): string {
    const calls = getTauriInvokeCalls('database_query');
    return (calls[calls.length - 1]!.payload as InvokeArgs & { request: { sql: string } }).request
        .sql;
}

function summaryRow(overrides: Partial<ToolPartSummaryRow> = {}): ToolPartSummaryRow {
    return {
        id: 1,
        message_id: 2,
        session_id: 3,
        tool_call_id: 'call-1',
        created_at: CREATED_AT,
        status: 'success',
        duration_ms: 12,
        tool_name: 'bash',
        server_id: null,
        input_preview: '{"command":"ls"}',
        output_length: 42,
        ...overrides,
    };
}

function flatToolPartRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        message_id: 2,
        type: 'tool_call',
        content: '',
        data: '{"output":"ok"}',
        tool_call_id: 'call-1',
        tool_kind: 'builtin',
        tool_id: 'bash',
        server_id: null,
        attachment_id: null,
        started_at: null,
        ended_at: null,
        sort_order: 0,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        session_id: 3,
        ...overrides,
    };
}
describe('when the settings page reads several keys at once', () => {
    beforeEach(() => {
        interceptTauriInvoke(() => undefined);
    });

    it('user gets an empty result without a query when no key is requested', async () => {
        expect(await getSettingValues({ keys: [] })).toEqual({});
        expect(getTauriInvokeCalls('database_query')).toHaveLength(0);
    });

    it('user gets every requested key, with missing ones reported as null', async () => {
        respondWithRows([{ key: 'language', value: 'zh' }]);

        const values = await getSettingValues({ keys: ['language', 'missing'] });

        expect(values).toEqual({ language: 'zh', missing: null });
        expect(lastSql()).toContain('in (');
    });
});

describe('when the settings log viewer pages through tool parts', () => {
    it('user gets a summary row with defaults filled in for missing data', async () => {
        respondWithRows([summaryRow({ tool_name: null as never, status: null as never })]);

        const rows = await findToolPartSummaries('builtin', undefined, { limit: 20, offset: 40 });

        expect(rows[0]).toMatchObject({ tool_name: '', status: 'pending' });
        const sql = lastSql();
        expect(sql).toContain('limit');
        expect(sql).toContain('offset');
    });

    it('user gets summaries without paging when no limit is requested', async () => {
        respondWithRows([summaryRow()]);

        const rows = await findToolPartSummaries('mcp');

        expect(rows).toHaveLength(1);
        expect(lastSql()).toContain('json_extract');
    });

    it('user gets the full part only when the id and kind both match', async () => {
        respondWithRows([flatToolPartRow({ id: 9, tool_call_id: 'call-9' })]);

        const part = await findToolPartById('builtin', 9);

        expect(part).toMatchObject({ id: 9, session_id: 3 });
        expect(lastSql()).toContain('"tool_kind" =');
    });
    it('user gets nothing when the part is gone', async () => {
        respondWithRows([]);

        expect(await findToolPartById('mcp', 404)).toBeUndefined();
    });
});

describe('when the log viewers load one entry by id', () => {
    it('user gets the built-in log entry by id', async () => {
        respondWithRows([flatToolPartRow({ id: 5, tool_call_id: 'call-5' })]);

        expect(await findBuiltInToolLogById(5)).toMatchObject({ id: 5 });
    });
    it('user gets the mcp log entry by id', async () => {
        respondWithRows([]);

        expect(await findMcpToolLogById(6)).toBeUndefined();
        expect(lastSql()).toContain('"tool_kind" =');
    });
});

describe('when the log viewers list entries for one owner', () => {
    it('user gets built-in entries filtered by tool id', async () => {
        respondWithRows([summaryRow({ tool_name: 'bash' })]);

        const rows = await findBuiltInToolLogSummariesByToolId('bash', { limit: 10, offset: 0 });

        expect(rows).toHaveLength(1);
        expect(lastSql()).toContain('"tool_id" =');
    });

    it('user gets mcp entries filtered by server id', async () => {
        respondWithRows([summaryRow({ server_id: 4 })]);

        const rows = await findMcpToolLogSummariesByServerId(4, { limit: 10, offset: 0 });

        expect(rows[0]).toMatchObject({ server_id: 4 });
        expect(lastSql()).toContain('"server_id" =');
    });
});
