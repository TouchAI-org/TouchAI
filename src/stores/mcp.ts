// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findAllMcpServers, findMcpToolsByServerId } from '@database/queries';
import type { McpServerEntity, McpToolEntity } from '@database/types';
import { AppEvent, eventService, type McpServerStatus } from '@services/EventService';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { mcpManager } from '@/services/AgentService/infrastructure/mcp';

export const useMcpStore = defineStore('mcp', () => {
    // 状态
    const servers = ref<McpServerEntity[]>([]);
    const statuses = ref<Record<number, McpServerStatus>>({});
    const errors = ref<Record<number, string | null>>({});
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

    function getServerError(id: number): string | null {
        return errors.value[id] ?? null;
    }

    function getServerTools(id: number): McpToolEntity[] {
        return tools.value[id] ?? [];
    }

    // 操作
    async function loadServers() {
        try {
            loading.value = true;
            servers.value = await findAllMcpServers();
            errors.value = Object.fromEntries(
                servers.value.map((server) => [server.id, server.last_error])
            );
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

    function setServerError(id: number, error: string | null) {
        errors.value[id] = error;
    }

    async function initialize() {
        if (initialized.value) return;

        await loadServers();

        // 首先将所有服务器初始化为 'disconnected' 状态
        // 真实状态会在 autoConnect 完成后通过 MCP_STATUS 事件更新
        // 这可以防止 UI 闪烁并提供一致的初始状态
        for (const server of servers.value) {
            setServerStatus(server.id, 'disconnected');
        }

        // 监听 MCP_STATUS 事件以实现跨窗口状态同步
        // 当一个窗口中的服务器连接/断开时，所有窗口都需要反映相同的状态
        // 事件系统处理这种广播
        await eventService.on(AppEvent.MCP_STATUS, (event) => {
            setServerStatus(event.serverId, event.status);
            setServerError(event.serverId, event.error ?? null);
            // 同步状态到 mcpManager 的缓存，以便 getEnabledToolDefinitions
            // 在为 AI 请求构建工具列表时能读取最新状态
            mcpManager.setStatusFromEvent(event.serverId, event.status, event.error ?? null);
            if (event.status === 'connected') {
                loadServerTools(event.serverId);
            }
        });

        // 从 Rust 后端批量刷新所有服务器状态
        // 这确保我们获得真实的连接状态，而不仅仅是数据库状态
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
        getServerError,
        getServerTools,
        // 操作
        loadServers,
        loadServerTools,
        setServerStatus,
        setServerError,
        initialize,
    };
});
