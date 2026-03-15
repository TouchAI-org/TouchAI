<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import SvgIcon from '@components/SvgIcon.vue';
    import { useContextMenu } from '@composables/useContextMenu.ts';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { deleteMcpServer, updateMcpServer } from '@database/queries';
    import type { McpServerEntity } from '@database/types';
    import { mcpManager } from '@services/AiService/mcp';
    import { onMounted, onUnmounted, ref, watch } from 'vue';

    import { useMcpStore } from '@/stores/mcp';

    defineOptions({
        name: 'SettingsMcpToolsSection',
    });

    import McpServerConfig from './components/McpServerConfig.vue';
    import McpServerList from './components/McpServerList.vue';
    import McpToolList from './components/McpToolList.vue';
    import McpToolLogViewer from './components/McpToolLogViewer.vue';

    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const selectedServer = ref<McpServerEntity | null>(null);
    const activeTab = ref<'config' | 'tools' | 'logs'>('config');
    const serverListRef = ref<InstanceType<typeof McpServerList> | null>(null);
    const tabContentRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(tabContentRef);
    const togglingServers = ref<Set<number>>(new Set());
    const activeCleanups = new Set<() => void>();

    // 组件卸载时清理所有活跃的 watcher 以防止内存泄漏
    onUnmounted(() => {
        for (const cleanup of activeCleanups) {
            cleanup();
        }
        activeCleanups.clear();
    });

    const mcpStore = useMcpStore();
    const { getServerStatus } = mcpStore;

    const getErrorMessage = (error: unknown, fallback = '未知错误'): string => {
        const message = error instanceof Error ? error.message : String(error);
        return message && message !== '[object Object]' ? message : fallback;
    };

    /**
     * MCP store 在设置窗口中按需初始化，避免用户未进入该分区时就执行状态刷新和事件订阅。
     */
    const ensureStoreInitialized = async () => {
        if (mcpStore.initialized) {
            return;
        }

        try {
            await mcpStore.initialize();
        } catch (error) {
            console.error('[McpToolsView] Failed to initialize MCP store:', error);
            alertMessage.value?.error(getErrorMessage(error, '加载 MCP 数据失败'), 6000);
        }
    };

    const { open: openServerMenu } = useContextMenu<number>(
        [{ key: 'delete', label: '删除', icon: 'trash', danger: true }],
        (key, serverId) => {
            if (key === 'delete') {
                handleDeleteServer(serverId);
            }
        }
    );

    // 监听服务器状态变化，在连接/断开完成后更新数据库并解锁 UI
    //
    // 状态转换：
    // - connecting → connected: 连接成功，在数据库中启用服务器
    // - connecting → error: 连接失败，不改变数据库（保持旧状态）
    // - connected/connecting → disconnected: 断开成功，在数据库中禁用服务器
    watch(
        () => Array.from(togglingServers.value).map((id) => getServerStatus(id)),
        async (newStatuses, oldStatuses) => {
            if (!oldStatuses) return;

            const serverIds = Array.from(togglingServers.value);
            for (let index = 0; index < serverIds.length; index++) {
                const serverId = serverIds[index]!;
                const oldStatus = oldStatuses[index];
                const newStatus = newStatuses[index];

                let shouldUnlock = false;
                let shouldUpdateDb = false;
                let newEnabledValue: 0 | 1 | null = null;

                // 连接成功：在数据库中启用服务器
                if (oldStatus === 'connecting' && newStatus === 'connected') {
                    shouldUnlock = true;
                    shouldUpdateDb = true;
                    newEnabledValue = 1;
                }
                // 连接失败：不修改启用状态（保留用户意图）
                else if (oldStatus === 'connecting' && newStatus === 'error') {
                    shouldUnlock = true;
                    shouldUpdateDb = false;
                }
                // 断开成功：在数据库中禁用服务器
                else if (
                    (oldStatus === 'connected' || oldStatus === 'connecting') &&
                    newStatus === 'disconnected'
                ) {
                    shouldUnlock = true;
                    shouldUpdateDb = true;
                    newEnabledValue = 0;
                }

                if (shouldUnlock) {
                    togglingServers.value.delete(serverId);

                    // 用新的启用状态更新数据库
                    if (shouldUpdateDb && newEnabledValue !== null) {
                        try {
                            await updateMcpServer(serverId, {
                                enabled: newEnabledValue,
                            });

                            // 刷新 UI 以反映数据库变化
                            await serverListRef.value?.loadServers();
                            if (selectedServer.value?.id === serverId) {
                                selectedServer.value = mcpStore.serverById(serverId) ?? null;
                            }
                        } catch (error) {
                            console.error('Failed to update server enabled status:', error);
                        }
                    }
                }
            }
        }
    );

    const handleServerSelect = (server: McpServerEntity) => {
        selectedServer.value = server;
        activeTab.value = 'config';
    };

    const handleAddServer = () => {
        serverListRef.value?.addNewServer();
    };

    const handleServerUpdated = async (wasNewServer: boolean) => {
        await serverListRef.value?.loadServers();

        if (wasNewServer) {
            serverListRef.value?.handleServerSaved();

            // 自动连接新创建的服务器（默认 enabled: 1）
            // 这提供了更好的用户体验：用户创建服务器后立即可用，无需手动连接
            const servers = mcpStore.servers;
            const newServer = servers[servers.length - 1];
            if (newServer) {
                try {
                    // 先在数据库中启用服务器
                    await updateMcpServer(newServer.id, { enabled: 1 });
                    await serverListRef.value?.loadServers();

                    // 然后发起连接
                    togglingServers.value.add(newServer.id);
                    await mcpManager.connectServer(newServer);
                } catch (error) {
                    console.error('Failed to auto-connect new server:', error);
                    alertMessage.value?.error(
                        `自动连接服务器失败: ${getErrorMessage(error)}`,
                        6000
                    );
                    togglingServers.value.delete(newServer.id);
                }
            }
        } else {
            alertMessage.value?.success('服务器配置已更新', 3000);
        }
    };

    const handleServerCancelled = () => {
        serverListRef.value?.handleServerCancelled();
    };

    const handleServerDeleted = () => {
        selectedServer.value = null;
        alertMessage.value?.success('服务器已删除', 3000);
        serverListRef.value?.loadServers();
    };

    const handleShowAlert = (message: string, type: 'success' | 'error') => {
        if (type === 'success') {
            alertMessage.value?.success(message, 3000);
        } else {
            alertMessage.value?.error(message, 6000);
        }
    };

    const handleToggleEnabled = async (serverId: number) => {
        // 防止双击触发多个操作
        // togglingServers 集合充当锁，确保每个服务器同时只运行一个连接/断开操作
        if (togglingServers.value.has(serverId)) {
            return;
        }

        try {
            const server = mcpStore.serverById(serverId);
            if (!server) return;

            const currentStatus = getServerStatus(serverId);
            const willEnable = !server.enabled;

            // 锁定切换开关以防止并发操作
            togglingServers.value.add(serverId);

            if (willEnable) {
                // 启用服务器：发起连接
                try {
                    await mcpManager.connectServer(server);
                } catch (error) {
                    console.error('Failed to connect server:', error);
                    alertMessage.value?.error(`连接服务器失败: ${getErrorMessage(error)}`, 6000);
                    togglingServers.value.delete(serverId);
                }
            } else {
                // 禁用服务器：如果已连接/正在连接则断开
                if (currentStatus === 'connected' || currentStatus === 'connecting') {
                    try {
                        await mcpManager.disconnectServer(serverId);
                    } catch (error) {
                        console.error('Failed to disconnect server:', error);
                        alertMessage.value?.error('断开服务器失败', 3000);
                        togglingServers.value.delete(serverId);
                    }
                } else {
                    // 已经断开/错误：直接更新数据库
                    try {
                        await updateMcpServer(serverId, {
                            enabled: 0,
                        });

                        await serverListRef.value?.loadServers();
                        if (selectedServer.value?.id === serverId) {
                            selectedServer.value = mcpStore.serverById(serverId) ?? null;
                        }
                    } catch (error) {
                        console.error('Failed to update server:', error);
                        alertMessage.value?.error('更新服务器状态失败', 3000);
                    }
                    togglingServers.value.delete(serverId);
                }
            }
        } catch (error) {
            console.error('Failed to toggle server:', error);
            alertMessage.value?.error('切换服务器状态失败', 3000);
            togglingServers.value.delete(serverId);
        }
    };

    /**
     * 等待服务器达到 disconnected 或 error 状态
     *
     * 这在删除服务器前使用，以确保连接完全关闭
     * 在服务器仍处于连接状态时删除可能会留下孤立的连接或导致竞态条件
     */
    const waitForServerDisconnect = (serverId: number, timeoutMs = 5000): Promise<void> => {
        return new Promise((resolve, reject) => {
            const currentStatus = getServerStatus(serverId);
            // 快速路径：已经断开连接
            if (currentStatus === 'disconnected' || currentStatus === 'error') {
                resolve();
                return;
            }

            const cleanup = () => {
                clearTimeout(timeoutId);
                unwatch();
                activeCleanups.delete(cleanup);
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('等待服务器断开超时'));
            }, timeoutMs);

            const unwatch = watch(
                () => getServerStatus(serverId),
                (newStatus) => {
                    if (newStatus === 'disconnected' || newStatus === 'error') {
                        cleanup();
                        resolve();
                    }
                }
            );

            activeCleanups.add(cleanup);
        });
    };

    const handleDeleteServer = async (serverId: number) => {
        try {
            const currentStatus = getServerStatus(serverId);
            // 删除前确保服务器已断开连接，以防止孤立的连接
            if (currentStatus === 'connected' || currentStatus === 'connecting') {
                await mcpManager.disconnectServer(serverId);
                await waitForServerDisconnect(serverId);
            }

            await deleteMcpServer(serverId);

            // 如果删除的是当前选中的服务器，清空选择
            if (selectedServer.value?.id === serverId) {
                selectedServer.value = null;
            }

            alertMessage.value?.success('服务器已删除', 3000);
            await mcpStore.loadServers();
            serverListRef.value?.loadServers();
        } catch (error) {
            console.error('Failed to delete server:', error);
            alertMessage.value?.error('删除服务器失败', 3000);
        }
    };

    const handleServerContextMenu = (serverId: number, event: MouseEvent) => {
        openServerMenu(event, serverId);
    };

    onMounted(() => {
        ensureStoreInitialized();
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div class="flex h-full">
        <!-- 左侧面板：服务器列表 -->
        <div class="flex h-full w-72 flex-col border-r border-gray-200 bg-white/60">
            <div class="border-b border-gray-200 bg-white/80 p-4">
                <h2 class="font-serif text-base font-semibold text-gray-900">MCP 服务器</h2>
            </div>

            <McpServerList
                ref="serverListRef"
                :selected-server="selectedServer"
                :toggling-servers="togglingServers"
                @select="handleServerSelect"
                @toggle-enabled="handleToggleEnabled"
                @delete="handleDeleteServer"
                @context-menu="handleServerContextMenu"
            />

            <div class="border-t border-gray-200 bg-white/80 p-3">
                <button
                    class="bg-primary-500 hover:bg-primary-600 w-full rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors"
                    @click="handleAddServer"
                >
                    + 添加 MCP 服务器
                </button>
            </div>
        </div>

        <!-- 右侧面板：服务器详情 -->
        <div class="flex flex-1 flex-col overflow-hidden">
            <div v-if="!selectedServer" class="flex h-full items-center justify-center">
                <div class="text-center">
                    <SvgIcon name="mcp" class="mx-auto h-16 w-16 text-gray-300" />
                    <p class="mt-4 font-serif text-sm text-gray-500">选择一个服务器查看详情</p>
                </div>
            </div>

            <template v-else>
                <!-- 标签页导航 -->
                <div
                    class="border-b border-gray-200 bg-white px-6"
                    style="padding-bottom: 1px; padding-top: 1px"
                >
                    <div class="flex gap-6">
                        <button
                            :class="[
                                'border-b-2 px-1 py-4 font-serif text-sm font-medium transition-colors',
                                activeTab === 'config'
                                    ? 'border-primary-600 text-primary-600'
                                    : 'border-transparent text-gray-500 hover:text-gray-700',
                            ]"
                            @click="activeTab = 'config'"
                        >
                            配置
                        </button>
                        <button
                            :class="[
                                'border-b-2 px-1 py-4 font-serif text-sm font-medium transition-colors',
                                activeTab === 'tools'
                                    ? 'border-primary-600 text-primary-600'
                                    : 'border-transparent text-gray-500 hover:text-gray-700',
                            ]"
                            @click="activeTab = 'tools'"
                        >
                            工具
                        </button>
                        <button
                            :class="[
                                'border-b-2 px-1 py-4 font-serif text-sm font-medium transition-colors',
                                activeTab === 'logs'
                                    ? 'border-primary-600 text-primary-600'
                                    : 'border-transparent text-gray-500 hover:text-gray-700',
                            ]"
                            @click="activeTab = 'logs'"
                        >
                            日志
                        </button>
                    </div>
                </div>

                <!-- 标签页内容 -->
                <div ref="tabContentRef" class="custom-scrollbar flex-1 overflow-y-auto">
                    <McpServerConfig
                        v-if="activeTab === 'config'"
                        :server="selectedServer"
                        @updated="handleServerUpdated"
                        @deleted="handleServerDeleted"
                        @cancelled="handleServerCancelled"
                        @show-alert="handleShowAlert"
                    />
                    <McpToolList v-if="activeTab === 'tools'" :server="selectedServer" />
                    <McpToolLogViewer v-if="activeTab === 'logs'" :server="selectedServer" />
                </div>
            </template>
        </div>
    </div>
</template>
