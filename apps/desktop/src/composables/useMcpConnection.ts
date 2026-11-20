// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { computed, onScopeDispose, type Ref, ref, watch } from 'vue';

import { log } from '@/app/api/diagnostics';
import { McpCommandError, useMcpApi } from '@/app/api/tools/mcp';
import { t } from '@/i18n';
import { useMcpStore } from '@/stores/mcp';
import { awaitAbortable } from '@/utils/abort';

type ConnectionOutcome = { success: boolean; error?: string };

/** Main's acknowledgement owns completion; status is only a display projection. */
export function useMcpConnection(serverId: Ref<number>) {
    const mcp = useMcpApi();
    const store = useMcpStore();
    const status = computed(() =>
        serverId.value === -1 ? 'disconnected' : store.getServerStatus(serverId.value)
    );
    const isConnecting = ref(false);
    const isDisconnecting = ref(false);
    const isReconnecting = ref(false);
    const pending = new Set<AbortController>();
    let disposed = false;
    let selection = 0;
    const busy = () => isConnecting.value || isDisconnecting.value || isReconnecting.value;
    const releaseWaits = () => {
        selection++;
        for (const controller of pending) controller.abort();
    };
    const stopSelection = watch(serverId, releaseWaits, { flush: 'sync' });

    async function perform(operation: 'connect' | 'disconnect'): Promise<ConnectionOutcome> {
        if (disposed) return { success: false };
        const id = serverId.value;
        if (!store.serverById(id))
            return { success: false, error: t('settings.mcp.connection.serverMissing') };
        const controller = new AbortController();
        const flag = operation === 'connect' ? isConnecting : isDisconnecting;
        pending.add(controller);
        flag.value = true;
        try {
            await awaitAbortable(
                () => (operation === 'connect' ? mcp.connectServer(id) : mcp.disconnectServer(id)),
                controller.signal
            );
            return { success: true };
        } catch (error) {
            // Closing a panel detaches its wait, never the shared native connection.
            if (controller.signal.aborted) return { success: false };
            log.warn('[MCP] Connection command failed', {
                operation,
                code: error instanceof McpCommandError ? error.code : 'MCP_COMMAND_FAILED',
            });
            const timeout =
                error instanceof McpCommandError && error.code === 'MCP_COMMAND_UNCONFIRMED';
            return {
                success: false,
                error: timeout
                    ? t(
                          operation === 'connect'
                              ? 'settings.mcp.connection.connectTimeout'
                              : 'settings.mcp.connection.disconnectTimeout'
                      )
                    : t(
                          operation === 'connect'
                              ? 'settings.mcp.connection.connectFailed'
                              : 'settings.mcp.messages.disconnectFailed'
                      ),
            };
        } finally {
            pending.delete(controller);
            flag.value = false;
        }
    }
    const handleConnect = (): Promise<ConnectionOutcome> =>
        busy() ? Promise.resolve({ success: false }) : perform('connect');
    const handleDisconnect = (): Promise<ConnectionOutcome> =>
        busy() ? Promise.resolve({ success: false }) : perform('disconnect');
    async function handleReconnect(): Promise<ConnectionOutcome> {
        if (busy() || disposed) return { success: false };
        isReconnecting.value = true;
        const captured = selection;
        try {
            const disconnected = await perform('disconnect');
            if (disposed || captured !== selection) return { success: false };
            if (!disconnected.success)
                return {
                    success: false,
                    error: t('settings.mcp.connection.disconnectFailedWithError', {
                        error: disconnected.error ?? '',
                    }),
                };
            const connected = await perform('connect');
            if (disposed || captured !== selection) return { success: false };
            return connected.success
                ? connected
                : {
                      success: false,
                      error: t('settings.mcp.connection.reconnectFailedWithError', {
                          error: connected.error ?? '',
                      }),
                  };
        } finally {
            isReconnecting.value = false;
        }
    }
    function cleanup() {
        if (disposed) return;
        disposed = true;
        stopSelection();
        releaseWaits();
    }
    onScopeDispose(cleanup);
    return {
        status,
        isConnecting,
        isDisconnecting,
        isReconnecting,
        handleConnect,
        handleDisconnect,
        handleReconnect,
        cleanup,
    };
}
