// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

/**
 * MCP Manager - 管理 MCP 服务器连接和工具调用
 *
 * 这个管理器作为前端的 MCP 客户端，通过 NativeService 与 Rust 后端通信
 */

import { db } from '@database';
import {
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
import { log } from '@services/ObservabilityService';
import { eq } from 'drizzle-orm';

import { t } from '@/i18n';
import { parseMcpToolSchemaJson } from '@/utils/mcpSchemas';
import { clampTimeoutMs, resolveAdaptiveTimeoutCeilingMs } from '@/utils/timeouts';

import type { AiToolDefinition } from '../../contracts/tooling';
import {
    extractMcpToolAttachments,
    formatMcpToolResponse,
    localizeNativeMcpTimeoutError,
    MCP_TIMEOUT_GUARD_GRACE_MS,
    normalizeErrorMessage,
    raceWithTimeoutAndSignal,
    readOptionalMcpArgs,
    readOptionalMcpRecord,
} from './utils';

/**
 * MCP 管理器类
 */
export class McpManager {
    private statusCache: Map<number, McpServerStatus> = new Map();
    private errorCache: Map<number, string | null> = new Map();

    private async persistServerError(serverId: number, error: string | null): Promise<void> {
        try {
            await updateMcpServer(serverId, { last_error: error });
        } catch (persistError) {
            log.error(`[McpManager] Failed to persist error for server ${serverId}:`, persistError);
        }
    }

    /**
     * 自动连接所有已启用的服务器
     */
    async autoConnect(): Promise<void> {
        log.debug('[McpManager] Starting auto-connect...');

        try {
            const enabledServers = await findEnabledMcpServers();

            log.debug(
                `[McpManager] Found ${enabledServers.length} enabled servers`,
                enabledServers.map((server) => `${server.name}(id: ${server.id})`).join(',')
            );

            // 逐个连接服务器以避免 SQLite "database is locked" 错误
            // 并行连接会导致并发写入数据库（更新状态、同步工具），SQLite 无法安全处理
            for (const server of enabledServers) {
                try {
                    await this.connectServer(server);
                } catch (error) {
                    log.error(`[McpManager] Failed to connect server ${server.name}:`, error);
                }
            }
        } catch (error) {
            log.error('[McpManager] Auto-connect failed:', error);
            throw error;
        }
    }

    /**
     * 连接到指定服务器
     */
    async connectServer(server: McpServerEntity): Promise<void> {
        log.debug(`[McpManager] Connecting to server: ${server.name} (${server.transport_type})`);

        try {
            // 更新状态为连接中
            this.updateStatus(server.id, 'connecting');

            // 调用 Rust 后端连接
            await mcp.connectServer({
                id: server.id,
                name: server.name,
                transport_type: server.transport_type as McpTransportType,
                command: server.command || undefined,
                args: readOptionalMcpArgs(server.args),
                env: readOptionalMcpRecord(server.env),
                cwd: server.cwd || undefined,
                url: server.url || undefined,
                headers: readOptionalMcpRecord(server.headers),
                enabled: Boolean(server.enabled), // 转换为布尔值
                tool_timeout: server.tool_timeout,
            });

            // 更新状态为已连接
            this.updateStatus(server.id, 'connected', null);
            await this.persistServerError(server.id, null);

            log.debug(`[McpManager] Successfully connected to ${server.name}`);

            // 获取服务器版本信息并更新到数据库
            try {
                const statusInfo = await mcp.getServerStatus(server.id);
                if (statusInfo.version) {
                    await updateMcpServer(server.id, { version: statusInfo.version });
                    log.debug(`[McpManager] Updated server version: ${statusInfo.version}`);
                }
            } catch (error) {
                log.error(`[McpManager] Failed to get server version:`, error);
            }

            // 同步工具列表到数据库
            await this.syncToolsToDatabase(server.id);
        } catch (error) {
            log.error(`[McpManager] Failed to connect to ${server.name}:`, error);
            const errorMessage = normalizeErrorMessage(error);
            this.updateStatus(server.id, 'error', errorMessage);
            await this.persistServerError(server.id, errorMessage);
            throw error;
        }
    }

    /**
     * 同步工具列表到数据库
     */
    private async syncToolsToDatabase(serverId: number): Promise<void> {
        try {
            log.debug(`[McpManager] Syncing tools for server ${serverId}...`);

            // 获取工具列表
            const tools = await this.listTools(serverId);

            const existingTools = await findMcpToolsByServerId(serverId);
            // 保留用户对现有工具的启用/禁用偏好
            // 当服务器重新连接时，我们希望保持用户之前启用或禁用的工具状态，而不是全部重置为启用
            const existingEnabledByName = new Map(
                existingTools.map((tool) => [tool.name, tool.enabled])
            );

            await db.transaction(async (tx) => {
                await tx.delete(mcpTools).where(eq(mcpTools.server_id, serverId)).run();

                if (tools.length > 0) {
                    await tx
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
            });

            log.debug(`[McpManager] Synced ${tools.length} tools for server ${serverId}`);
        } catch (error) {
            log.error(`[McpManager] Failed to sync tools for server ${serverId}:`, error);
        }
    }

    /**
     * 断开服务器连接
     */
    async disconnectServer(serverId: number): Promise<void> {
        log.debug(`[McpManager] Disconnecting server: ${serverId}`);

        try {
            await mcp.disconnectServer(serverId);
            this.updateStatus(serverId, 'disconnected', null);
            await this.persistServerError(serverId, null);
            log.debug(`[McpManager] Successfully disconnected server ${serverId}`);
        } catch (error) {
            log.error(`[McpManager] Failed to disconnect server ${serverId}:`, error);
            throw error;
        }
    }

    /**
     * 断开所有服务器连接
     */
    async disconnectAll(timeout: number = 5000): Promise<void> {
        log.debug('[McpManager] Disconnecting all servers...');

        let timer: ReturnType<typeof setTimeout> | undefined;
        let didTimeout = false;

        try {
            const disconnectPromise = mcp.disconnectAll();
            void disconnectPromise
                .then(() => {
                    if (didTimeout) {
                        this.statusCache.clear();
                        log.debug('[McpManager] All servers disconnected after timeout');
                    }
                })
                .catch((disconnectError) => {
                    if (didTimeout) {
                        log.error(
                            '[McpManager] disconnectAll rejected after timeout:',
                            disconnectError
                        );
                    }
                });

            const timeoutPromise = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    didTimeout = true;
                    reject(new Error(t('agent.mcp.disconnectTimeout')));
                }, timeout);
            });

            await Promise.race([disconnectPromise, timeoutPromise]);

            this.statusCache.clear();
            log.debug('[McpManager] All servers disconnected');
        } catch (error) {
            log.error('[McpManager] Failed to disconnect all servers:', error);
            throw error;
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }

    /**
     * 列出服务器的所有工具
     */
    async listTools(serverId: number): Promise<McpToolDefinition[]> {
        try {
            return await mcp.listTools(serverId);
        } catch (error) {
            log.error(`[McpManager] Failed to list tools for server ${serverId}:`, error);
            throw error;
        }
    }

    /**
     * 调用工具
     */
    async callTool(
        serverId: number,
        toolName: string,
        args: Record<string, unknown>,
        timeoutMs?: number
    ): Promise<McpToolCallResponse> {
        try {
            return await mcp.callTool(serverId, toolName, args, timeoutMs);
        } catch (error) {
            log.error(`[McpManager] Failed to call tool ${toolName}:`, error);
            throw error;
        }
    }

    /**
     * 获取服务器状态（从缓存）
     */
    getServerStatus(serverId: number): McpServerStatus {
        return this.statusCache.get(serverId) || 'disconnected';
    }

    getServerError(serverId: number): string | null {
        return this.errorCache.get(serverId) ?? null;
    }

    /**
     * 从外部更新状态缓存（用于跨窗口事件同步）
     */
    setStatusFromEvent(serverId: number, status: McpServerStatus, error?: string | null): void {
        this.statusCache.set(serverId, status);
        this.errorCache.set(serverId, error ?? null);
    }

    /**
     * 刷新服务器状态（从后端）
     */
    async refreshServerStatus(serverId: number): Promise<McpServerStatus> {
        try {
            const statusInfo = await mcp.getServerStatus(serverId);
            this.updateStatus(serverId, statusInfo.status, statusInfo.error ?? null);
            return statusInfo.status;
        } catch (error) {
            log.error(`[McpManager] Failed to refresh status for server ${serverId}:`, error);
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
                this.updateStatus(
                    statusInfo.server_id,
                    statusInfo.status,
                    statusInfo.error ?? null
                );
            }
        } catch (error) {
            log.error('[McpManager] Failed to refresh all server statuses:', error);
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
                        const inputSchema = parseMcpToolSchemaJson(tool.input_schema);
                        return {
                            name: `mcp__${server.id}__${tool.name}`,
                            description:
                                tool.description ||
                                t('agent.mcp.toolDescriptionFallback', { toolName: tool.name }),
                            input_schema: inputSchema as AiToolDefinition['input_schema'],
                            adaptiveTimeoutCeilingMs: resolveAdaptiveTimeoutCeilingMs(
                                server.tool_timeout
                            ),
                        };
                    });
                    allTools.push(...toolsWithNamespace);
                } catch (error) {
                    log.error(`[McpManager] Failed to get tools for server ${server.name}:`, error);
                }
            }

            return allTools;
        } catch (error) {
            log.error('[McpManager] Failed to get enabled tool definitions:', error);
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
            log.debug(`[McpManager] Resolving tool call: ${toolName}`);

            // 解析命名空间格式: mcp__{serverId}__{toolName}
            const match = toolName.match(/^mcp__(\d+)__(.+)$/);
            if (!match) {
                log.error(`[McpManager] Invalid tool name format: ${toolName}`);
                return null;
            }

            const serverId = parseInt(match[1]!, 10);
            const originalToolName = match[2]!;

            log.debug(`[McpManager] Parsed: serverId=${serverId}, toolName=${originalToolName}`);

            // 查找服务器
            const server = await findMcpServerById(serverId);

            if (!server) {
                log.error(`[McpManager] Server not found: ${serverId}`);
                return null;
            }

            if (!server.enabled) {
                log.error(`[McpManager] Server disabled: ${serverId} (${server.name})`);
                return null;
            }

            log.debug(`[McpManager] Found server: ${server.name} (id=${server.id})`);

            // 验证工具是否存在
            const tool = await findMcpToolByServerIdAndName(server.id, originalToolName);
            if (!tool) {
                log.error(
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
            log.error('[McpManager] Failed to resolve tool call:', error);
            return null;
        }
    }

    /**
     * 执行工具调用，支持超时和取消
     * 处理工具名称解析、超时竞争和响应格式化
     */
    async executeTool(
        toolName: string,
        args: Record<string, unknown>,
        options?: {
            signal?: AbortSignal;
            iteration?: number;
            toolCallId?: string;
            resolved?: { serverId: number; originalName: string; toolTimeout: number };
            requestedTimeoutMs?: number;
        }
    ): Promise<{
        result: string;
        isError: boolean;
        attachments?: Awaited<ReturnType<typeof extractMcpToolAttachments>>;
    }> {
        // 如果请求已被取消，立即返回，避免消耗
        if (options?.signal?.aborted) {
            return { result: t('agent.mcp.requestCancelled'), isError: true };
        }

        const resolved = options?.resolved ?? (await this.resolveToolCall(toolName));

        if (!resolved) {
            throw new Error(t('agent.mcp.toolNotFound', { toolName }));
        }

        // 服务器配置来自数据库，是无约束输入。正数必须是安全整数才能跨 Tauri 的
        // u64 边界，也无法用本地计时器兜底；这类值只能报配置错误，不能静默变成
        // “不设超时”，否则用户以为设了上限，实际调用完全不受限。
        if (resolved.toolTimeout > 0 && !Number.isSafeInteger(resolved.toolTimeout)) {
            throw new Error(
                t('agent.mcp.invalidToolTimeout', { timeoutMs: String(resolved.toolTimeout) })
            );
        }

        // 服务器配置的超时既是本次调用的默认值，也是硬上限：模型只能收紧。
        // 配置非正数表示不设超时，此时保持用户的“不限制”语义，不接受模型建议。
        const effectiveTimeout =
            resolved.toolTimeout > 0
                ? clampTimeoutMs(
                      options?.requestedTimeoutMs,
                      resolved.toolTimeout,
                      resolved.toolTimeout
                  )
                : resolved.toolTimeout;

        // 非正数沿用既有语义（不设超时），此时不向原生层传递超时参数。
        const nativeTimeoutMs =
            Number.isSafeInteger(effectiveTimeout) && effectiveTimeout > 0
                ? effectiveTimeout
                : undefined;

        // 超时同时下发给 Rust：rmcp 会在到点时向服务器发送取消通知，避免本地已
        // 判定超时、远端却仍在执行造成副作用重复。本地竞争只作兜底守卫，并多留
        // 一个宽限窗口，让原生取消先于本地超时报告触发。
        const callPromise = this.callTool(
            resolved.serverId,
            resolved.originalName,
            args,
            nativeTimeoutMs
        );
        const guardTimeoutMs =
            nativeTimeoutMs === undefined
                ? effectiveTimeout
                : nativeTimeoutMs + MCP_TIMEOUT_GUARD_GRACE_MS;
        let response: McpToolCallResponse;
        try {
            response = await raceWithTimeoutAndSignal(
                callPromise,
                guardTimeoutMs,
                options?.signal,
                effectiveTimeout
            );
        } catch (error) {
            // 原生超时通常先于本地守卫返回，统一翻译成既有超时文案。
            throw localizeNativeMcpTimeoutError(error, effectiveTimeout);
        }

        const result = formatMcpToolResponse(response);
        let attachments: Awaited<ReturnType<typeof extractMcpToolAttachments>> | undefined;
        try {
            attachments = await extractMcpToolAttachments(response, {
                toolCallId: options?.toolCallId ?? resolved.originalName,
                toolName: resolved.originalName,
            });
        } catch (error) {
            log.error('[McpManager] Failed to persist MCP tool attachments:', error);
        }

        return {
            result,
            isError: response.is_error,
            attachments,
        };
    }

    /**
     * 更新状态并发送事件
     */
    private updateStatus(
        serverId: number,
        status: McpServerStatus,
        error: string | null = null
    ): void {
        this.statusCache.set(serverId, status);
        this.errorCache.set(serverId, error);
        eventService.emit(AppEvent.MCP_STATUS, {
            serverId,
            status,
            error: error ?? undefined,
        });
    }
}
