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
import type { DatabaseOperation } from '@services/NativeService/database';
import { getTauriInvokeCalls, interceptTauriInvoke } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

const CREATED_AT = '2026-05-29T00:00:00.000Z';

function respondWithOperation(kind: DatabaseOperation['kind'], value: unknown) {
    interceptTauriInvoke((call) => {
        if (call.cmd !== 'database_operation') return undefined;
        const request = (call.payload as { request?: DatabaseOperation } | undefined)?.request;
        return request?.kind === kind ? value : undefined;
    });
}

function respondWithSettingValues(values: Record<string, string | null>) {
    respondWithOperation('setting_get_many', values);
}

function lastOperation(): DatabaseOperation {
    const calls = getTauriInvokeCalls('database_operation');
    return (calls[calls.length - 1]!.payload as { request: DatabaseOperation }).request;
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
        expect(getTauriInvokeCalls('database_operation')).toHaveLength(0);
    });

    it('user gets every requested key, with missing ones reported as null', async () => {
        respondWithSettingValues({ language: 'zh', missing: null });

        const values = await getSettingValues({ keys: ['language', 'missing'] });

        expect(values).toEqual({ language: 'zh', missing: null });
        expect(lastOperation()).toEqual({
            kind: 'setting_get_many',
            keys: ['language', 'missing'],
        });
    });
});

describe('when the settings log viewer pages through tool parts', () => {
    it('user sends the typed summary request with paging', async () => {
        respondWithOperation('tool_part_summaries', [summaryRow()]);

        const rows = await findToolPartSummaries(
            'builtin',
            { kind: 'tool_call_id', toolCallId: 'call-1' },
            { limit: 20, offset: 40 }
        );

        expect(rows).toHaveLength(1);
        expect(lastOperation()).toEqual({
            kind: 'tool_part_summaries',
            toolKind: 'builtin',
            filter: { kind: 'tool_call_id', toolCallId: 'call-1' },
            limit: 20,
            offset: 40,
        });
    });

    it('user gets summaries without paging when no limit is requested', async () => {
        respondWithOperation('tool_part_summaries', [summaryRow()]);

        const rows = await findToolPartSummaries('mcp', {
            kind: 'tool_call_id',
            toolCallId: 'call-2',
        });

        expect(rows).toHaveLength(1);
        expect(lastOperation()).toEqual({
            kind: 'tool_part_summaries',
            toolKind: 'mcp',
            filter: { kind: 'tool_call_id', toolCallId: 'call-2' },
            limit: undefined,
            offset: undefined,
        });
    });

    it('user gets the full part only when the id and kind both match', async () => {
        respondWithOperation('tool_part_list', [
            flatToolPartRow({ id: 9, tool_call_id: 'call-9' }),
        ]);

        const part = await findToolPartById('builtin', 9);

        expect(part).toMatchObject({ id: 9, session_id: 3 });
        expect(lastOperation()).toEqual({
            kind: 'tool_part_list',
            toolKind: 'builtin',
            filter: { kind: 'id', id: 9 },
            limit: 1,
            offset: 0,
        });
    });

    it('user gets nothing when the part is gone', async () => {
        respondWithOperation('tool_part_list', []);

        expect(await findToolPartById('mcp', 404)).toBeUndefined();
        expect(lastOperation()).toEqual({
            kind: 'tool_part_list',
            toolKind: 'mcp',
            filter: { kind: 'id', id: 404 },
            limit: 1,
            offset: 0,
        });
    });
});

describe('when the log viewers load one entry by id', () => {
    it('user gets the built-in log entry by id', async () => {
        respondWithOperation('tool_part_list', [
            flatToolPartRow({ id: 5, tool_call_id: 'call-5' }),
        ]);

        expect(await findBuiltInToolLogById(5)).toMatchObject({ id: 5 });
        expect(lastOperation()).toEqual({
            kind: 'tool_part_list',
            toolKind: 'builtin',
            filter: { kind: 'id', id: 5 },
            limit: 1,
            offset: 0,
        });
    });

    it('user gets the mcp log entry by id', async () => {
        respondWithOperation('tool_part_list', []);

        expect(await findMcpToolLogById(6)).toBeUndefined();
        expect(lastOperation()).toEqual({
            kind: 'tool_part_list',
            toolKind: 'mcp',
            filter: { kind: 'id', id: 6 },
            limit: 1,
            offset: 0,
        });
    });
});

describe('when the log viewers list entries for one owner', () => {
    it('user gets built-in entries filtered by tool id', async () => {
        respondWithOperation('tool_part_summaries', [summaryRow({ tool_name: 'bash' })]);

        const rows = await findBuiltInToolLogSummariesByToolId('bash', {
            limit: 10,
            offset: 0,
        });

        expect(rows).toHaveLength(1);
        expect(lastOperation()).toEqual({
            kind: 'tool_part_summaries',
            toolKind: 'builtin',
            filter: { kind: 'tool_id', toolId: 'bash' },
            limit: 10,
            offset: 0,
        });
    });

    it('user gets mcp entries filtered by server id', async () => {
        respondWithOperation('tool_part_summaries', [summaryRow({ server_id: 4 })]);

        const rows = await findMcpToolLogSummariesByServerId(4, { limit: 10, offset: 0 });

        expect(rows[0]).toMatchObject({ server_id: 4 });
        expect(lastOperation()).toEqual({
            kind: 'tool_part_summaries',
            toolKind: 'mcp',
            filter: { kind: 'server_id', serverId: 4 },
            limit: 10,
            offset: 0,
        });
    });
});
