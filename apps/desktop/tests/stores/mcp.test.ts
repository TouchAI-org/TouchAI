import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppEvent, eventService } from '@/app/workflows/windows/events';
import {
    flushObservability,
    initObservability,
    resetObservabilityForTests,
} from '@/platform/diagnostics';

import { closeTestDatabases } from '../database/sqliteHarness';
import { mountMcpWindow } from '../utils/mcpWindow';
import { getTauriInvokeCalls, interceptTauriInvoke } from '../utils/tauri';

let fixture: Awaited<ReturnType<typeof mountMcpWindow<undefined>>>;
beforeEach(async () => {
    fixture = await mountMcpWindow(() => undefined, { label: 'main' });
});
afterEach(async () => {
    resetObservabilityForTests();
    await fixture.dispose();
    closeTestDatabases();
});

describe('given the MCP view reads saved data through its production window bindings', () => {
    it('user sees an empty list with loading finished when saved servers cannot be read', async () => {
        interceptTauriInvoke((call, next) => {
            if (
                call.cmd === 'database_query' &&
                (call.payload as { request: { sql: string } }).request.sql.includes(
                    'from "mcp_servers"'
                )
            ) {
                throw new Error('fixture database is locked');
            }
            return next();
        });
        await expect(fixture.store.loadServers()).resolves.toBeUndefined();
        expect(fixture.store.servers).toEqual([]);
        expect(fixture.store.loading).toBe(false);
    });

    it('user sees no tools for a server whose saved tools cannot be read', async () => {
        interceptTauriInvoke((call, next) => {
            if (
                call.cmd === 'database_query' &&
                (call.payload as { request: { sql: string } }).request.sql.includes(
                    'from "mcp_tools"'
                )
            ) {
                throw new Error('fixture database is locked');
            }
            return next();
        });
        await expect(fixture.store.loadServerTools(1)).resolves.toBeUndefined();
        expect(fixture.store.getServerTools(1)).toEqual([]);
    });

    it('user receives one diagnostic failure per error transition rather than one per repeated status broadcast', async () => {
        await fixture.store.initialize();
        initObservability();
        await eventService.emit(AppEvent.MCP_STATUS, {
            serverId: 1,
            status: 'error',
            error: 'spawn failed',
        });
        await eventService.emit(AppEvent.MCP_STATUS, {
            serverId: 1,
            status: 'error',
            error: 'spawn failed',
        });
        await eventService.emit(AppEvent.MCP_STATUS, { serverId: 1, status: 'connected' });
        await eventService.emit(AppEvent.MCP_STATUS, {
            serverId: 1,
            status: 'error',
            error: 'spawn failed again',
        });
        await flushPromises();
        await flushObservability();
        const failures = getTauriInvokeCalls('obs_ingest')
            .flatMap(
                ({ payload }) =>
                    (payload as { batch: { event: string; attrs: Record<string, unknown> }[] })
                        .batch
            )
            .filter(({ event }) => event === 'mcp.connect.failed');
        expect(failures).toHaveLength(2);
        expect(failures.every(({ attrs }) => attrs['mcp.server.id'] === 1)).toBe(true);
        expect(fixture.store.getServerError(1)).toBe('spawn failed again');
    });
});
