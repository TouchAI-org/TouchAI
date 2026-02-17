// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findAllMcpServers, findMcpToolsByServerId } from '@database/queries';
import type { McpServerEntity, McpToolEntity } from '@database/types';
import { mcpManager } from '@services/AiService/mcp';
import { AppEvent, eventService, type McpServerStatus } from '@services/EventService';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export const useMcpStore = defineStore('mcp', () => {
    // 状态
    const servers = ref<McpServerEntity[]>([]);
    const statuses = ref<Record<number, McpServerStatus>>({});
    const tools = ref<Record<number, McpToolEntity[]>>({});
    const initialized = ref(false);
    const loading = ref(false);

    // 计算属性
    const enabledServers = computed(() => servers.value.filter((s) => s.enabled));

    const serverNameById = computed(() => {
        const map = new Map<number, string>();
        for (const s of servers.value) map.set(s.id, s.name);
        return (id: number) => map.get(id) ?? `Server ${id}`;
    });

    const serverById = computed(() => {
        const map = new Map<number, McpServerEntity>();
        for (const s of servers.value) map.set(s.id, s);
        return (id: number) => map.get(id);
    });

    function getServerStatus(id: number): McpServerStatus {
        return statuses.value[id] ?? 'disconnected';
    }

    function getServerTools(id: number): McpToolEntity[] {
        return tools.value[id] ?? [];
    }

    // 操作
    async function loadServers() {
        try {
            loading.value = true;
            servers.value = await findAllMcpServers();
        } catch (error) {
            console.error('[McpStore] Failed to load servers:', error);
        } finally {
            loading.value = false;
        }
    }

    async function loadServerTools(serverId: number) {
        try {
            tools.value[serverId] = await findMcpToolsByServerId(serverId);
        } catch (error) {
            console.error(`[McpStore] Failed to load tools for server ${serverId}:`, error);
        }
    }

    function setServerStatus(id: number, status: McpServerStatus) {
        statuses.value[id] = status;
    }

    async function initialize() {
        if (initialized.value) return;

        await loadServers();

        // 初始化所有服务器状态为 disconnected
        // 真实状态会通过 MCP_STATUS 事件在 autoConnect 完成后更新
        for (const server of servers.value) {
            setServerStatus(server.id, 'disconnected');
        }

        // 监听 MCP_STATUS 事件（跨窗口状态同步）
        await eventService.on(AppEvent.MCP_STATUS, (event) => {
            setServerStatus(event.serverId, event.status);
            // 同步更新 mcpManager 的状态缓存，确保 getEnabledToolDefinitions 能读到最新状态
            mcpManager.setStatusFromEvent(event.serverId, event.status);
            if (event.status === 'connected') {
                loadServerTools(event.serverId);
            }
        });

        // 从 Rust 后端批量刷新所有服务器的真实状态
        await mcpManager.refreshAllServerStatuses();

        initialized.value = true;
    }

    return {
        // 状态
        servers,
        statuses,
        tools,
        initialized,
        loading,
        // 计算属性
        enabledServers,
        serverNameById,
        serverById,
        getServerStatus,
        getServerTools,
        // 操作
        loadServers,
        loadServerTools,
        setServerStatus,
        initialize,
    };
});
