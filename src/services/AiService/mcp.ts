// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * MCP Manager - 管理 MCP 服务器连接和工具调用
 *
 * 这个管理器作为前端的 MCP 客户端，通过 NativeService 与 Rust 后端通信
 */

import { db } from '@database';
import {
    deleteMcpToolsByServerId,
    findEnabledMcpServers,
    findEnabledMcpToolsByServerId,
    findMcpServerById,
    findMcpToolByServerIdAndName,
    findMcpToolsByServerId,
    updateMcpServer,
} from '@database/queries';
import { mcpTools } from '@database/schema';
import type { McpServerEntity } from '@database/types';
import { AppEvent, eventService, type McpServerStatus } from '@services/EventService';
import {
    mcp,
    type McpToolCallResponse,
    type McpToolDefinition,
    type McpTransportType,
} from '@services/NativeService';

import type { AiToolDefinition } from './types';

/**
 * MCP 管理器类
 */
class McpManager {
    private statusCache: Map<number, McpServerStatus> = new Map();

    /**
     * 自动连接所有已启用的服务器
     */
    async autoConnect(): Promise<void> {
        console.log('[McpManager] Starting auto-connect...');

        try {
            const enabledServers = await findEnabledMcpServers();

            console.log(
                `[McpManager] Found ${enabledServers.length} enabled servers`,
                enabledServers.map((server) => `${server.name}(id: ${server.id})`).join(',')
            );

            // 逐个连接服务器，避免并发写数据库导致 "database is locked"
            for (const server of enabledServers) {
                try {
                    await this.connectServer(server);
                } catch (error) {
                    console.error(`[McpManager] Failed to connect server ${server.name}:`, error);
                }
            }
        } catch (error) {
            console.error('[McpManager] Auto-connect failed:', error);
            throw error;
        }
    }

    /**
     * 连接到指定服务器
     */
    async connectServer(server: McpServerEntity): Promise<void> {
        console.log(`[McpManager] Connecting to server: ${server.name} (${server.transport_type})`);

        try {
            // 更新状态为连接中
            this.updateStatus(server.id, 'connecting');

            // 调用 Rust 后端连接
            await mcp.connectServer({
                id: server.id,
                name: server.name,
                transport_type: server.transport_type as McpTransportType,
                command: server.command || undefined,
                args: server.args ? JSON.parse(server.args) : undefined,
                env: server.env ? JSON.parse(server.env) : undefined,
                cwd: server.cwd || undefined,
                url: server.url || undefined,
                headers: server.headers ? JSON.parse(server.headers) : undefined,
                enabled: Boolean(server.enabled), // 转换为布尔值
                tool_timeout: server.tool_timeout,
            });

            // 更新状态为已连接
            this.updateStatus(server.id, 'connected');

            console.log(`[McpManager] Successfully connected to ${server.name}`);

            // 获取服务器版本信息并更新到数据库
            try {
                const statusInfo = await mcp.getServerStatus(server.id);
                if (statusInfo.version) {
                    await updateMcpServer(server.id, { version: statusInfo.version });
                    console.log(`[McpManager] Updated server version: ${statusInfo.version}`);
                }
            } catch (error) {
                console.error(`[McpManager] Failed to get server version:`, error);
            }

            // 同步工具列表到数据库
            await this.syncToolsToDatabase(server.id);
        } catch (error) {
            console.error(`[McpManager] Failed to connect to ${server.name}:`, error);
            this.updateStatus(server.id, 'error');
            throw error;
        }
    }

    /**
     * 同步工具列表到数据库
     */
    private async syncToolsToDatabase(serverId: number): Promise<void> {
        try {
            console.log(`[McpManager] Syncing tools for server ${serverId}...`);

            // 获取工具列表
            const tools = await this.listTools(serverId);

            const existingTools = await findMcpToolsByServerId(serverId);
            const existingEnabledByName = new Map(
                existingTools.map((tool) => [tool.name, tool.enabled])
            );

            const drizzle = db.getDb();

            // 删除旧的工具列表
            await deleteMcpToolsByServerId(serverId);

            // 批量插入新的工具列表
            if (tools.length > 0) {
                await drizzle
                    .insert(mcpTools)
                    .values(
                        tools.map((tool) => ({
                            server_id: serverId,
                            name: tool.name,
                            description: tool.description || null,
                            input_schema: JSON.stringify(tool.input_schema),
                            enabled: existingEnabledByName.get(tool.name) ?? 1,
                        }))
                    )
                    .run();
            }

            console.log(`[McpManager] Synced ${tools.length} tools for server ${serverId}`);
        } catch (error) {
            console.error(`[McpManager] Failed to sync tools for server ${serverId}:`, error);
        }
    }

    /**
     * 断开服务器连接
     */
    async disconnectServer(serverId: number): Promise<void> {
        console.log(`[McpManager] Disconnecting server: ${serverId}`);

        try {
            await mcp.disconnectServer(serverId);
            this.updateStatus(serverId, 'disconnected');
            console.log(`[McpManager] Successfully disconnected server ${serverId}`);
        } catch (error) {
            console.error(`[McpManager] Failed to disconnect server ${serverId}:`, error);
            throw error;
        }
    }

    /**
     * 断开所有服务器连接
     */
    async disconnectAll(timeout: number = 5000): Promise<void> {
        console.log('[McpManager] Disconnecting all servers...');

        try {
            const disconnectPromise = mcp.disconnectAll();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Disconnect timeout')), timeout)
            );

            await Promise.race([disconnectPromise, timeoutPromise]);

            this.statusCache.clear();
            console.log('[McpManager] All servers disconnected');
        } catch (error) {
            console.error('[McpManager] Failed to disconnect all servers:', error);
            throw error;
        }
    }

    /**
     * 列出服务器的所有工具
     */
    async listTools(serverId: number): Promise<McpToolDefinition[]> {
        try {
            return await mcp.listTools(serverId);
        } catch (error) {
            console.error(`[McpManager] Failed to list tools for server ${serverId}:`, error);
            throw error;
        }
    }

    /**
     * 调用工具
     */
    async callTool(
        serverId: number,
        toolName: string,
        args: Record<string, unknown>
    ): Promise<McpToolCallResponse> {
        try {
            return await mcp.callTool(serverId, toolName, args);
        } catch (error) {
            console.error(`[McpManager] Failed to call tool ${toolName}:`, error);
            throw error;
        }
    }

    /**
     * 获取服务器状态（从缓存）
     */
    getServerStatus(serverId: number): McpServerStatus {
        return this.statusCache.get(serverId) || 'disconnected';
    }

    /**
     * 从外部更新状态缓存（用于跨窗口事件同步）
     */
    setStatusFromEvent(serverId: number, status: McpServerStatus): void {
        this.statusCache.set(serverId, status);
    }

    /**
     * 刷新服务器状态（从后端）
     */
    async refreshServerStatus(serverId: number): Promise<McpServerStatus> {
        try {
            const statusInfo = await mcp.getServerStatus(serverId);
            this.updateStatus(serverId, statusInfo.status);
            return statusInfo.status;
        } catch (error) {
            console.error(`[McpManager] Failed to refresh status for server ${serverId}:`, error);
            return 'disconnected';
        }
    }

    /**
     * 批量刷新所有服务器状态（从后端）
     */
    async refreshAllServerStatuses(): Promise<void> {
        try {
            const statuses = await mcp.getAllServerStatuses();
            for (const statusInfo of statuses) {
                this.updateStatus(statusInfo.server_id, statusInfo.status);
            }
        } catch (error) {
            console.error('[McpManager] Failed to refresh all server statuses:', error);
        }
    }

    /**
     * 获取所有已启用的工具定义（用于 AI 请求）
     */
    async getEnabledToolDefinitions(): Promise<AiToolDefinition[]> {
        try {
            const enabledServers = await findEnabledMcpServers();
            const allTools: AiToolDefinition[] = [];

            for (const server of enabledServers) {
                // 只包含实际已连接的服务器的工具
                if (this.getServerStatus(server.id) !== 'connected') {
                    continue;
                }

                try {
                    const tools = await findEnabledMcpToolsByServerId(server.id);

                    const toolsWithNamespace: AiToolDefinition[] = tools.map((tool) => {
                        const raw = JSON.parse(tool.input_schema || '{}');
                        // 确保 input_schema 至少包含 type 和 properties
                        const inputSchema: AiToolDefinition['input_schema'] = {
                            ...raw,
                            type: raw.type ?? 'object',
                            properties: raw.properties ?? {},
                        };
                        return {
                            name: `mcp__${server.id}__${tool.name}`,
                            description: tool.description || `Tool: ${tool.name}`,
                            input_schema: inputSchema,
                        };
                    });
                    allTools.push(...toolsWithNamespace);
                } catch (error) {
                    console.error(
                        `[McpManager] Failed to get tools for server ${server.name}:`,
                        error
                    );
                }
            }

            return allTools;
        } catch (error) {
            console.error('[McpManager] Failed to get enabled tool definitions:', error);
            return [];
        }
    }

    /**
     * 解析工具调用（查找工具所属的服务器）
     */
    async resolveToolCall(toolName: string): Promise<{
        serverId: number;
        originalName: string;
        toolTimeout: number;
    } | null> {
        try {
            console.log(`[McpManager] Resolving tool call: ${toolName}`);

            // 解析命名空间格式: mcp__{serverId}__{toolName}
            const match = toolName.match(/^mcp__(\d+)__(.+)$/);
            if (!match) {
                console.error(`[McpManager] Invalid tool name format: ${toolName}`);
                return null;
            }

            const serverId = parseInt(match[1]!, 10);
            const originalToolName = match[2]!;

            console.log(`[McpManager] Parsed: serverId=${serverId}, toolName=${originalToolName}`);

            // 查找服务器
            const server = await findMcpServerById(serverId);

            if (!server) {
                console.error(`[McpManager] Server not found: ${serverId}`);
                return null;
            }

            if (!server.enabled) {
                console.error(`[McpManager] Server disabled: ${serverId} (${server.name})`);
                return null;
            }

            console.log(`[McpManager] Found server: ${server.name} (id=${server.id})`);

            // 验证工具是否存在
            const tool = await findMcpToolByServerIdAndName(server.id, originalToolName);
            if (!tool) {
                console.error(
                    `[McpManager] Tool not found: ${originalToolName} on server ${server.name}`
                );
                return null;
            }

            return {
                serverId: server.id,
                originalName: originalToolName,
                toolTimeout: server.tool_timeout,
            };
        } catch (error) {
            console.error('[McpManager] Failed to resolve tool call:', error);
            return null;
        }
    }

    /**
     * 执行工具调用
     */
    async executeTool(
        toolName: string,
        args: Record<string, unknown>,
        options?: {
            signal?: AbortSignal;
            iteration?: number;
            resolved?: { serverId: number; originalName: string; toolTimeout: number };
        }
    ): Promise<{ result: string; isError: boolean }> {
        // 执行前检查是否已取消
        if (options?.signal?.aborted) {
            return { result: 'Request cancelled', isError: true };
        }

        const resolved = options?.resolved ?? (await this.resolveToolCall(toolName));

        if (!resolved) {
            throw new Error(`Tool not found: ${toolName}`);
        }

        // 将工具调用与超时和中止信号进行竞争
        const callPromise = this.callTool(resolved.serverId, resolved.originalName, args);
        const response = await this.raceWithTimeoutAndSignal(
            callPromise,
            resolved.toolTimeout,
            options?.signal
        );

        // 将 MCP 响应转换为 AI 服务期望的格式
        const result = response.content
            .map((item) => {
                if (item.type === 'text') {
                    return item.text || '';
                } else if (item.type === 'image') {
                    return `[Image: ${item.mime_type}]`;
                } else if (item.type === 'resource') {
                    return item.text || `[Resource: ${item.uri}]`;
                }
                return '';
            })
            .join('\n');

        return {
            result,
            isError: response.is_error,
        };
    }

    /**
     * Race a promise against a timeout and an optional AbortSignal.
     * 所有 racer 在主 promise settle 后都会被清理，避免 Promise 泄漏。
     */
    private raceWithTimeoutAndSignal<T>(
        promise: Promise<T>,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<T> {
        // 无超时且无有效信号时直接返回原 promise
        if (timeoutMs <= 0 && (!signal || signal.aborted)) {
            return promise;
        }

        return new Promise<T>((resolve, reject) => {
            let settled = false;

            const settle = (fn: typeof resolve | typeof reject, value: T | Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                (fn as (v: T | Error) => void)(value);
            };

            let timer: ReturnType<typeof setTimeout> | undefined;
            const onAbort = () => settle(reject, new Error('Request cancelled'));

            const cleanup = () => {
                if (timer !== undefined) clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            };

            // 主 promise
            promise.then(
                (value) => settle(resolve, value),
                (error) => settle(reject, error)
            );

            // 超时竞争者
            if (timeoutMs > 0) {
                timer = setTimeout(
                    () =>
                        settle(reject, new Error(`Tool execution timed out after ${timeoutMs}ms`)),
                    timeoutMs
                );
            }

            // 中止信号竞争者
            if (signal && !signal.aborted) {
                signal.addEventListener('abort', onAbort, { once: true });
            } else if (signal?.aborted) {
                settle(reject, new Error('Request cancelled'));
            }
        });
    }

    /**
     * 更新状态并发送事件
     */
    private updateStatus(serverId: number, status: McpServerStatus): void {
        this.statusCache.set(serverId, status);
        eventService.emit(AppEvent.MCP_STATUS, {
            serverId,
            status,
        });
    }
}

// 导出单例
export const mcpManager = new McpManager();
