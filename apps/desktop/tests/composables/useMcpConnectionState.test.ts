import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useMcpConnection } from '@/composables/useMcpConnection';
import { setLocale } from '@/i18n';

import { closeTestDatabases } from '../database/sqliteHarness';
import { mountMcpWindow } from '../utils/mcpWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

type Fixture = Awaited<ReturnType<typeof mountMcpWindow<ReturnType<typeof useMcpConnection>>>>;
let fixture: Fixture;
const selected = ref(1);
beforeEach(async () => {
    selected.value = 1;
    setLocale('en-US');
    fixture = await mountMcpWindow(() => useMcpConnection(selected));
    await fixture.store.initialize();
});
afterEach(async () => {
    await fixture.dispose();
    closeTestDatabases();
    vi.useRealTimers();
});

describe('given settings controls the main-owned MCP connection', () => {
    it('user sees a busy button until main confirms connection and the synchronized tool catalog', async () => {
        const wait = deferred();
        mockTauriCommand('mcp_connect_server', () => wait.promise);
        const pending = fixture.value.handleConnect();
        expect(fixture.value.isConnecting.value).toBe(true);
        await flushPromises();
        expect(fixture.value.status.value).toBe('connecting');
        wait.resolve();
        await expect(pending).resolves.toEqual({ success: true });
        await flushPromises();
        expect(fixture.value.isConnecting.value).toBe(false);
        expect(fixture.value.status.value).toBe('connected');
    });

    it('user receives one refused duplicate command while the first connection is still pending', async () => {
        const wait = deferred();
        mockTauriCommand('mcp_connect_server', () => wait.promise);
        const pending = fixture.value.handleConnect();
        expect(await fixture.value.handleConnect()).toEqual({ success: false });
        await flushPromises();
        expect(getTauriInvokeCalls('mcp_connect_server')).toHaveLength(1);
        wait.resolve();
        await pending;
    });

    it('user sees a stable failure immediately when main refuses the connection and can try again', async () => {
        mockTauriCommand('mcp_connect_server', () => {
            throw new Error('private native failure');
        });
        await expect(fixture.value.handleConnect()).resolves.toEqual({
            success: false,
            error: 'Connection failed',
        });
        expect(fixture.value.isConnecting.value).toBe(false);
        mockTauriCommand('mcp_connect_server', null);
        await expect(fixture.value.handleConnect()).resolves.toEqual({ success: true });
    });

    it('user sees a missing-server message without a native connection after the server is deleted', async () => {
        fixture.database.exec('DELETE FROM mcp_servers WHERE id = 1');
        await fixture.store.loadServers();
        await expect(fixture.value.handleConnect()).resolves.toEqual({
            success: false,
            error: 'Server does not exist',
        });
        expect(getTauriInvokeCalls('mcp_connect_server')).toEqual([]);
    });

    it('user disconnects and receives success only after main confirms native disconnection', async () => {
        await fixture.value.handleConnect();
        const wait = deferred();
        mockTauriCommand('mcp_disconnect_server', () => wait.promise);
        const pending = fixture.value.handleDisconnect();
        expect(fixture.value.isDisconnecting.value).toBe(true);
        expect(await fixture.value.handleDisconnect()).toEqual({ success: false });
        wait.resolve();
        await expect(pending).resolves.toEqual({ success: true });
        await flushPromises();
        expect(fixture.value.status.value).toBe('disconnected');
        expect(fixture.value.isDisconnecting.value).toBe(false);
    });

    it('user reconnects only after confirmed disconnection without a speculative settling delay', async () => {
        await fixture.value.handleConnect();
        const wait = deferred();
        mockTauriCommand('mcp_disconnect_server', () => wait.promise);
        const pending = fixture.value.handleReconnect();
        await flushPromises();
        expect(fixture.value.isReconnecting.value).toBe(true);
        expect(getTauriInvokeCalls('mcp_connect_server')).toHaveLength(1);
        wait.resolve();
        await expect(pending).resolves.toEqual({ success: true });
        expect(getTauriInvokeCalls('mcp_connect_server')).toHaveLength(2);
        expect(fixture.value.isReconnecting.value).toBe(false);
    });

    it('user cannot start reconnect while a connection is already pending', async () => {
        const wait = deferred();
        mockTauriCommand('mcp_connect_server', () => wait.promise);
        const pending = fixture.value.handleConnect();
        expect(await fixture.value.handleReconnect()).toEqual({ success: false });
        wait.resolve();
        await pending;
    });

    it('user closes the panel and its pending wait settles without pretending the native connection stopped', async () => {
        const wait = deferred();
        mockTauriCommand('mcp_connect_server', () => wait.promise);
        const pending = fixture.value.handleConnect();
        await flushPromises();
        fixture.value.cleanup();
        fixture.value.cleanup();
        await expect(pending).resolves.toEqual({ success: false });
        expect(fixture.value.isConnecting.value).toBe(false);
        expect(getTauriInvokeCalls('mcp_disconnect_server')).toEqual([]);
        wait.resolve();
        await flushPromises();
        expect(fixture.store.getServerStatus(1)).toBe('connected');
    });

    it('user selects another server and a late result cannot report success for the new selection', async () => {
        const wait = deferred();
        mockTauriCommand('mcp_connect_server', () => wait.promise);
        const pending = fixture.value.handleConnect();
        await flushPromises();
        selected.value = 2;
        await expect(pending).resolves.toEqual({ success: false });
        expect(fixture.value.status.value).toBe('disconnected');
        wait.resolve();
        await flushPromises();
        expect(fixture.store.getServerStatus(1)).toBe('connected');
        expect(fixture.value.status.value).toBe('disconnected');
    });

    it('user sees disconnected status and no previous error for the empty selection', async () => {
        selected.value = -1;
        expect(fixture.value.status.value).toBe('disconnected');
        await expect(fixture.value.handleConnect()).resolves.toEqual({
            success: false,
            error: 'Server does not exist',
        });
    });
});
