<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { McpServerEntity } from '@database/types';
    import { computed, onMounted, ref } from 'vue';

    import { useMcpStore } from '@/stores/mcp';

    import McpServerCard from './McpServerCard.vue';

    interface Props {
        selectedServer: McpServerEntity | null;
        togglingServers: Set<number>;
    }

    interface Emits {
        (e: 'select', server: McpServerEntity): void;
        (e: 'toggle-enabled', serverId: number): void;
        (e: 'delete', serverId: number): void;
        (e: 'context-menu', serverId: number, event: MouseEvent): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const mcpStore = useMcpStore();
    const servers = computed(() => mcpStore.servers);
    const loading = computed(() => mcpStore.loading);
    const newServer = ref<Partial<McpServerEntity> | null>(null);

    const loadServers = async () => {
        await mcpStore.loadServers();

        // 如果有服务器且当前没有选中任何服务器，自动选中第一个
        if (servers.value.length > 0 && !props.selectedServer && !newServer.value) {
            emit('select', servers.value[0]!);
        }
    };

    const handleSelect = (server: McpServerEntity) => {
        // 如果正在新建服务器，点击其他服务器时取消新建
        if (newServer.value) {
            newServer.value = null;
        }
        emit('select', server);
    };

    const handleToggleEnabled = (serverId: number) => {
        emit('toggle-enabled', serverId);
    };

    const handleDelete = (serverId: number) => {
        emit('delete', serverId);
    };

    const handleContextMenu = (serverId: number, event: MouseEvent) => {
        emit('context-menu', serverId, event);
    };

    const addNewServer = () => {
        // 创建临时新服务器对象
        newServer.value = {
            id: -1, // 临时 ID
            name: '',
            transport_type: 'stdio',
            command: null,
            args: null,
            env: null,
            cwd: null,
            url: null,
            headers: null,
            enabled: 1,
            tool_timeout: 30000,
            last_connected_at: null,
            last_error: null,
            version: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        // 自动选中新服务器
        emit('select', newServer.value as McpServerEntity);
    };

    const handleServerSaved = async () => {
        newServer.value = null;
        await loadServers();
        // 选中最新创建的服务器（通常是列表中的最后一个）
        if (servers.value.length > 0) {
            emit('select', servers.value[servers.value.length - 1]!);
        }
    };

    const handleServerCancelled = () => {
        newServer.value = null;
        // 如果有其他服务器，选中第一个
        if (servers.value.length > 0) {
            emit('select', servers.value[0]!);
        }
    };

    onMounted(() => {
        loadServers();
    });

    defineExpose({ loadServers, addNewServer, handleServerCancelled, handleServerSaved });
</script>

<template>
    <div class="custom-scrollbar flex-1 space-y-2 overflow-y-auto p-3">
        <div v-if="loading" class="space-y-2">
            <div v-for="i in 3" :key="i" class="h-20 animate-pulse rounded-lg bg-gray-100" />
        </div>

        <div v-else-if="servers.length === 0 && !newServer" class="py-8 text-center">
            <p class="font-serif text-sm text-gray-500">暂无服务器</p>
            <p class="mt-1 font-serif text-xs text-gray-400">点击下方按钮添加服务器</p>
        </div>

        <div v-else class="space-y-2">
            <!-- 新服务器编辑卡片 -->
            <div v-if="newServer" class="border-primary-400 bg-primary-50 rounded-lg border-2 p-4">
                <p class="font-serif text-sm font-medium text-gray-900">新建服务器</p>
                <p class="mt-1 font-serif text-xs text-gray-500">请在右侧填写服务器配置</p>
            </div>

            <!-- 现有服务器列表 -->
            <McpServerCard
                v-for="server in servers"
                :key="server.id"
                :server="server"
                :selected="selectedServer?.id === server.id"
                :is-toggling="togglingServers.has(server.id)"
                @click="handleSelect(server)"
                @toggle-enabled="handleToggleEnabled"
                @delete="handleDelete(server.id)"
                @context-menu="handleContextMenu(server.id, $event)"
            />
        </div>
    </div>
</template>
