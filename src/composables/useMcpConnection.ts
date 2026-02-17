// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { mcpManager } from '@services/AiService/mcp';
import type { Ref } from 'vue';
import { computed, ref, watch } from 'vue';

import { useMcpStore } from '@/stores/mcp';

/**
 * MCP 服务器连接管理
 * 封装连接、断开、重连逻辑和状态跟踪
 */
export function useMcpConnection(serverId: Ref<number>) {
    const mcpStore = useMcpStore();

    const status = computed(() =>
        serverId.value === -1 ? 'disconnected' : mcpStore.getServerStatus(serverId.value)
    );

    const isConnecting = ref(false);
    const isDisconnecting = ref(false);
    const isReconnecting = ref(false);

    // 跟踪 handleReconnect 中创建的 watcher，在卸载时清理
    const activeUnwatchers = new Set<() => void>();

    const handleConnect = async (): Promise<{ success: boolean; error?: string }> => {
        if (isConnecting.value) return { success: false };

        isConnecting.value = true;
        try {
            const server = mcpStore.serverById(serverId.value);
            if (!server) {
                isConnecting.value = false;
                return { success: false, error: '服务器不存在' };
            }
            mcpManager.connectServer(server).catch(() => {});

            // 等待状态变化
            return await new Promise<{ success: boolean; error?: string }>((resolve) => {
                const timeoutId = setTimeout(() => {
                    unwatch();
                    activeUnwatchers.delete(unwatch);
                    isConnecting.value = false;
                    resolve({ success: false, error: '连接超时' });
                }, 15000);

                const unwatch = watch(status, (newStatus) => {
                    if (newStatus === 'connected') {
                        clearTimeout(timeoutId);
                        unwatch();
                        activeUnwatchers.delete(unwatch);
                        isConnecting.value = false;
                        resolve({ success: true });
                    } else if (newStatus === 'error') {
                        clearTimeout(timeoutId);
                        unwatch();
                        activeUnwatchers.delete(unwatch);
                        isConnecting.value = false;
                        resolve({ success: false, error: '连接失败' });
                    }
                });
                activeUnwatchers.add(unwatch);
            });
        } catch (error) {
            isConnecting.value = false;
            console.error('Failed to connect:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };

    const handleDisconnect = async (): Promise<{ success: boolean; error?: string }> => {
        if (isDisconnecting.value) return { success: false };

        isDisconnecting.value = true;
        try {
            mcpManager.disconnectServer(serverId.value).catch(() => {});

            return await new Promise<{ success: boolean; error?: string }>((resolve) => {
                const timeoutId = setTimeout(() => {
                    unwatch();
                    activeUnwatchers.delete(unwatch);
                    isDisconnecting.value = false;
                    resolve({ success: false, error: '断开超时' });
                }, 5000);

                const unwatch = watch(status, (newStatus) => {
                    if (newStatus === 'disconnected') {
                        clearTimeout(timeoutId);
                        unwatch();
                        activeUnwatchers.delete(unwatch);
                        isDisconnecting.value = false;
                        resolve({ success: true });
                    }
                });
                activeUnwatchers.add(unwatch);
            });
        } catch (error) {
            isDisconnecting.value = false;
            console.error('Failed to disconnect:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };

    const handleReconnect = async (): Promise<{ success: boolean; error?: string }> => {
        if (isConnecting.value || isDisconnecting.value || isReconnecting.value) {
            return { success: false };
        }

        isReconnecting.value = true;
        try {
            const disconnectResult = await handleDisconnect();
            if (!disconnectResult.success) {
                return { success: false, error: `断开失败: ${disconnectResult.error}` };
            }

            // 等待状态稳定
            await new Promise((resolve) => setTimeout(resolve, 500));

            const connectResult = await handleConnect();
            if (!connectResult.success) {
                return { success: false, error: `重连失败: ${connectResult.error}` };
            }

            return { success: true };
        } catch (error) {
            console.error('Failed to reconnect:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        } finally {
            isReconnecting.value = false;
        }
    };

    const cleanup = () => {
        for (const unwatch of activeUnwatchers) {
            unwatch();
        }
        activeUnwatchers.clear();
    };

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
