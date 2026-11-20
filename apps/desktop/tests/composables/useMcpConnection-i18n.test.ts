import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useMcpConnection } from '@/composables/useMcpConnection';
import { setLocale } from '@/i18n';

import { closeTestDatabases } from '../database/sqliteHarness';
import { mountMcpWindow } from '../utils/mcpWindow';
import { mockTauriCommand } from '../utils/tauri';

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

describe('given a main-owned MCP command is unavailable or unconfirmed', () => {
    it('user sees a localized missing-server message when connecting an absent selection', async () => {
        selected.value = 404;
        await expect(fixture.value.handleConnect()).resolves.toEqual({
            success: false,
            error: 'Server does not exist',
        });
    });

    it('user sees a localized connection timeout when main cannot confirm the operation', async () => {
        vi.useFakeTimers();
        mockTauriCommand('mcp_connect_server', () => new Promise(() => {}));
        const pending = fixture.value.handleConnect();
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(pending).resolves.toEqual({ success: false, error: 'Connection timed out' });
        expect(fixture.value.isConnecting.value).toBe(false);
    });

    it('user sees a localized disconnect timeout when main cannot confirm native shutdown', async () => {
        vi.useFakeTimers();
        mockTauriCommand('mcp_disconnect_server', () => new Promise(() => {}));
        const pending = fixture.value.handleDisconnect();
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(pending).resolves.toEqual({ success: false, error: 'Disconnect timed out' });
        expect(fixture.value.isDisconnecting.value).toBe(false);
        // Host cleanup has its own native shutdown deadline; restore that boundary for disposal.
        mockTauriCommand('mcp_disconnect_server', null);
    });

    it('user sees both the reconnect failure and its localized reason without a new connection attempt', async () => {
        vi.useFakeTimers();
        mockTauriCommand('mcp_disconnect_server', () => new Promise(() => {}));
        const pending = fixture.value.handleReconnect();
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(pending).resolves.toEqual({
            success: false,
            error: 'Disconnect failed: Disconnect timed out',
        });
        expect(fixture.value.isReconnecting.value).toBe(false);
        mockTauriCommand('mcp_disconnect_server', null);
    });
});
