// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { Ref } from 'vue';
import { computed, ref, watch } from 'vue';

import { mcpManager } from '@/services/AgentService/infrastructure/mcp';
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
    const lastError = computed(() =>
        serverId.value === -1 ? null : mcpStore.getServerError(serverId.value)
    );

    const isConnecting = ref(false);
    const isDisconnecting = ref(false);
    const isReconnecting = ref(false);

    // 跟踪活跃的 watcher 以防止内存泄漏
    // 每个连接/断开操作都会创建一个监听状态变化的 watcher
    // 如果组件在操作完成前卸载，需要清理这些 watcher 以避免内存泄漏
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
            // 发起连接请求但不等待结果，实际结果通过状态事件返回
            mcpManager.connectServer(server).catch(() => {});

            // 通过响应式 watch 模式等待状态变化
            // 这是必要的，因为 MCP 连接是异步的，状态更新通过事件系统传递，而非直接返回值
            return await new Promise<{ success: boolean; error?: string }>((resolve) => {
                // 连接尝试的 15 秒超时
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
                        resolve({ success: false, error: lastError.value || '连接失败' });
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

            // 等待状态稳定后再重新连接
            // 这可以防止竞态条件：新连接尝试在旧连接完全清理前就开始
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
