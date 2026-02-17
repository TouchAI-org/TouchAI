<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AlertMessage from '@components/common/AlertMessage.vue';
    import SvgIcon from '@components/common/SvgIcon.vue';
    import McpServerConfig from '@components/settings/mcp/McpServerConfig.vue';
    import McpServerList from '@components/settings/mcp/McpServerList.vue';
    import McpToolList from '@components/settings/mcp/McpToolList.vue';
    import McpToolLogViewer from '@components/settings/mcp/McpToolLogViewer.vue';
    import { useContextMenu } from '@composables/useContextMenu.ts';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { deleteMcpServer, updateMcpServer } from '@database/queries';
    import type { McpServerEntity } from '@database/types';
    import { mcpManager } from '@services/AiService/mcp';
    import { onUnmounted, ref, watch } from 'vue';

    import { useMcpStore } from '@/stores/mcp';

    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const selectedServer = ref<McpServerEntity | null>(null);
    const activeTab = ref<'config' | 'tools' | 'logs'>('config');
    const serverListRef = ref<InstanceType<typeof McpServerList> | null>(null);
    const tabContentRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(tabContentRef);
    const togglingServers = ref<Set<number>>(new Set());
    const activeCleanups = new Set<() => void>();

    onUnmounted(() => {
        for (const cleanup of activeCleanups) {
            cleanup();
        }
        activeCleanups.clear();
    });

    const mcpStore = useMcpStore();
    const { getServerStatus } = mcpStore;

    const { open: openServerMenu } = useContextMenu<number>(
        [{ key: 'delete', label: '删除', icon: 'trash', danger: true }],
        (key, serverId) => {
            if (key === 'delete') {
                handleDeleteServer(serverId);
            }
        }
    );

    // 监听服务器状态变化，当连接或断开完成时更新数据库并解除禁用
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

                // 连接成功：启用服务器
                if (oldStatus === 'connecting' && newStatus === 'connected') {
                    shouldUnlock = true;
                    shouldUpdateDb = true;
                    newEnabledValue = 1;
                }
                // 连接失败：不启用服务器
                else if (oldStatus === 'connecting' && newStatus === 'error') {
                    shouldUnlock = true;
                    shouldUpdateDb = false; // 连接失败，不修改 enabled 状态
                }
                // 断开成功：禁用服务器
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

                    //更新数据库
                    if (shouldUpdateDb && newEnabledValue !== null) {
                        try {
                            await updateMcpServer(serverId, {
                                enabled: newEnabledValue,
                            });

                            // 刷新 UI
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
            // 新服务器保存成功
            serverListRef.value?.handleServerSaved();

            // 自动连接新创建的服务器（默认 enabled: 1）
            // 取列表中最后一个服务器（即刚创建的）
            const servers = mcpStore.servers;
            const newServer = servers[servers.length - 1];
            if (newServer && newServer.enabled) {
                try {
                    togglingServers.value.add(newServer.id);
                    await mcpManager.connectServer(newServer);
                } catch (error) {
                    console.error('Failed to auto-connect new server:', error);
                    alertMessage.value?.error('自动连接服务器失败', 3000);
                    togglingServers.value.delete(newServer.id);
                }
            }
        } else {
            // 现有服务器更新成功
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
            alertMessage.value?.error(message, 3000);
        }
    };

    const handleToggleEnabled = async (serverId: number) => {
        // 防止重复点击
        if (togglingServers.value.has(serverId)) {
            return;
        }

        try {
            const server = mcpStore.serverById(serverId);
            if (!server) return;

            const currentStatus = getServerStatus(serverId);
            const willEnable = !server.enabled; // 将要启用还是禁用

            // 锁定开关
            togglingServers.value.add(serverId);

            // 执行连接/断开操作
            if (willEnable) {
                // 启用服务器：发起连接请求
                try {
                    await mcpManager.connectServer(server);
                } catch (error) {
                    console.error('Failed to connect server:', error);
                    alertMessage.value?.error('连接服务器失败', 3000);
                    togglingServers.value.delete(serverId);
                }
            } else {
                // 禁用服务器
                if (currentStatus === 'connected' || currentStatus === 'connecting') {
                    // 需要断开连接
                    try {
                        await mcpManager.disconnectServer(serverId);
                    } catch (error) {
                        console.error('Failed to disconnect server:', error);
                        alertMessage.value?.error('断开服务器失败', 3000);
                        togglingServers.value.delete(serverId);
                    }
                } else {
                    // 已经是 disconnected 或 error，直接更新数据库
                    try {
                        await updateMcpServer(serverId, {
                            enabled: 0,
                        });

                        // 刷新 UI
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

    const waitForServerDisconnect = (serverId: number, timeoutMs = 5000): Promise<void> => {
        return new Promise((resolve, reject) => {
            const currentStatus = getServerStatus(serverId);
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
            if (currentStatus === 'connected' || currentStatus === 'connecting') {
                await mcpManager.disconnectServer(serverId);
                await waitForServerDisconnect(serverId);
            }

            await deleteMcpServer(serverId);

            // 如果删除的是当前选中的服务器，清空选中状态
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
