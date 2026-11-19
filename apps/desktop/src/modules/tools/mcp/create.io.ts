import { db } from '@database';
import { eq } from '@database/expressions';
import {
    findEnabledMcpServers,
    findMcpServerById,
    updateMcpServer,
} from '@database/queries/mcpServers';
import {
    findEnabledMcpToolsByServerId,
    findMcpToolByServerIdAndName,
    findMcpToolsByServerId,
} from '@database/queries/mcpTools';
import { mcpTools } from '@database/schema';
import type { McpServerEntity } from '@database/types';

import { mcp } from '@/platform/native';
import { awaitAbortable } from '@/utils/abort';
import { parseMcpToolSchemaJson } from '@/utils/mcpSchemas';
import { clampTimeoutMs, resolveAdaptiveTimeoutCeilingMs } from '@/utils/timeouts';

import type {
    McpToolRegistration,
    ToolDeclaration,
    ToolInvocationScope,
    ToolResult,
} from '../contracts';
import type {
    McpConnectionEvent,
    McpConnectionsOptions,
    McpConnectionStatus,
} from '../contracts/mcp';
import { createMcpFormatting, MCP_TIMEOUT_GUARD_GRACE_MS } from './formatting';

function implementationKey(server: McpServerEntity): string {
    return JSON.stringify([
        server.transport_type,
        server.command,
        server.args,
        server.cwd,
        server.url,
    ]);
}

class McpCatalogCollision extends Error {}

export function createMcpConnections(input: McpConnectionsOptions) {
    const t = input.messages.t.bind(input.messages);
    const diagnostics = {
        debug: input.diagnostics.debug.bind(input.diagnostics),
        error: input.diagnostics.error.bind(input.diagnostics),
    };
    const formatting = createMcpFormatting(input.messages, input.resources);
    const statuses = new Map<number, { status: McpConnectionStatus; error: string | null }>();
    const generations = new Map<number, number>();
    const implementations = new Map<number, string>();
    const ownedConnections = new Set<number>();
    const effects = new Set<AbortController>();
    const listeners = new Set<(event: McpConnectionEvent) => void>();
    let disposed = false;
    let disposal: Promise<void> | undefined;
    const report = (message: string, error: unknown) => {
        try {
            diagnostics.error(message, error);
        } catch {
            /* Diagnostics cannot change a remote outcome. */
        }
    };
    const requireLive = () => {
        if (disposed) throw new Error('MCP_CONNECTIONS_DISPOSED');
    };
    const generation = (id: number) => generations.get(id) ?? 0;
    const invalidate = (id: number) => generations.set(id, generation(id) + 1);
    const status = (id: number) => statuses.get(id)?.status ?? 'disconnected';
    const updateStatus = (
        serverId: number,
        next: McpConnectionStatus,
        error: string | null = null
    ) => {
        if (disposed) return;
        if (next !== status(serverId)) invalidate(serverId);
        statuses.set(serverId, { status: next, error });
        const event = Object.freeze({ serverId, status: next, error });
        for (const listener of listeners) {
            try {
                listener(event);
            } catch (error) {
                diagnostics.error('[MCP] Status observer failed', error);
            }
        }
    };
    async function persistError(id: number, error: string | null): Promise<void> {
        try {
            requireLive();
            if (!(await updateMcpServer(id, { last_error: error })))
                throw new Error('MCP_SERVER_MISSING');
        } catch (failure) {
            report('[MCP] Error bookkeeping failed', failure);
        }
    }
    async function synchronizeTools(serverId: number): Promise<void> {
        const tools = await mcp.listTools(serverId);
        requireLive();
        const names = new Set<string>();
        for (const tool of tools) {
            if (names.has(tool.name))
                throw new McpCatalogCollision(
                    `Duplicate tool name: mcp__${serverId}__${tool.name}`
                );
            names.add(tool.name);
        }
        const existing = new Map(
            (await findMcpToolsByServerId(serverId)).map((tool) => [tool.name, tool.enabled])
        );
        await db.transaction(async (tx) => {
            await tx.delete(mcpTools).where(eq(mcpTools.server_id, serverId)).run();
            if (tools.length)
                await tx
                    .insert(mcpTools)
                    .values(
                        tools.map((tool) => ({
                            server_id: serverId,
                            name: tool.name,
                            description: tool.description || null,
                            input_schema: JSON.stringify(tool.input_schema),
                            enabled: existing.get(tool.name) ?? 1,
                        }))
                    )
                    .run();
        });
    }
    async function connect(
        serverId: number,
        origin: 'user' | 'background' = 'user',
        signal?: AbortSignal
    ): Promise<void> {
        requireLive();
        const stored = await awaitAbortable(() => findMcpServerById(serverId), signal);
        if (!stored) throw new Error('MCP_SERVER_MISSING');
        requireLive();
        signal?.throwIfAborted();
        const server = structuredClone(stored);
        invalidate(serverId);
        updateStatus(serverId, 'connecting');
        ownedConnections.add(serverId);
        try {
            await mcp.connectServer(
                {
                    id: server.id,
                    name: server.name,
                    transport_type: server.transport_type,
                    command: server.command || undefined,
                    args: formatting.readOptionalMcpArgs(server.args),
                    env: formatting.readOptionalMcpRecord(server.env),
                    cwd: server.cwd || undefined,
                    url: server.url || undefined,
                    headers: formatting.readOptionalMcpRecord(server.headers),
                    enabled: Boolean(server.enabled),
                    tool_timeout: server.tool_timeout,
                },
                origin
            );
            if (disposed) {
                await mcp.disconnectServer(serverId);
                throw new Error('MCP_CONNECTIONS_DISPOSED');
            }
            implementations.set(serverId, implementationKey(server));
            try {
                const info = await mcp.getServerStatus(serverId);
                requireLive();
                if (info.version) await updateMcpServer(serverId, { version: info.version });
            } catch (error) {
                requireLive();
                report('[MCP] Version probe failed', error);
            }
            try {
                await synchronizeTools(serverId);
            } catch (error) {
                requireLive();
                if (error instanceof McpCatalogCollision) throw error;
                report('[MCP] Catalog synchronization failed', error);
            }
            requireLive();
            await persistError(serverId, null);
            updateStatus(serverId, 'connected');
        } catch (error) {
            if (!disposed) {
                const message = formatting.normalizeErrorMessage(error);
                updateStatus(serverId, 'error', message);
                await persistError(serverId, message);
            }
            throw error;
        }
    }
    async function disconnect(serverId: number): Promise<void> {
        requireLive();
        invalidate(serverId);
        await mcp.disconnectServer(serverId);
        ownedConnections.delete(serverId);
        implementations.delete(serverId);
        await persistError(serverId, null);
        updateStatus(serverId, 'disconnected');
    }
    async function refresh(serverId?: number): Promise<McpConnectionEvent[]> {
        requireLive();
        const entries =
            serverId === undefined
                ? await mcp.getAllServerStatuses()
                : [await mcp.getServerStatus(serverId)];
        requireLive();
        for (const entry of entries) {
            const id = serverId ?? entry.server_id;
            updateStatus(id, entry.status, entry.error ?? null);
        }
        return entries.map((entry) => ({
            serverId: serverId ?? entry.server_id,
            status: entry.status,
            error: entry.error ?? null,
        }));
    }
    async function isAuthorized(
        server: McpServerEntity,
        name: string,
        capturedGeneration: number,
        scope: ToolInvocationScope
    ): Promise<boolean> {
        if (
            disposed ||
            scope.signal?.aborted ||
            status(server.id) !== 'connected' ||
            generation(server.id) !== capturedGeneration
        )
            return false;
        const current = await findMcpServerById(server.id);
        const tool = await findMcpToolByServerIdAndName(server.id, name);
        return (
            current?.enabled === 1 &&
            tool?.enabled === 1 &&
            implementationKey(current) === implementationKey(server) &&
            implementations.get(server.id) === implementationKey(server) &&
            !disposed &&
            !scope.signal?.aborted &&
            status(server.id) === 'connected' &&
            generation(server.id) === capturedGeneration
        );
    }
    async function execute(
        server: McpServerEntity,
        name: string,
        capturedGeneration: number,
        args: Record<string, unknown>,
        scope: ToolInvocationScope
    ): Promise<ToolResult> {
        if (!(await isAuthorized(server, name, capturedGeneration, scope)))
            throw new Error('MCP_BINDING_REVOKED');
        if (server.tool_timeout > 0 && !Number.isSafeInteger(server.tool_timeout)) {
            throw new Error(
                t('agent.mcp.invalidToolTimeout', { timeoutMs: String(server.tool_timeout) })
            );
        }
        const timeout =
            server.tool_timeout > 0
                ? clampTimeoutMs(scope.requestedTimeoutMs, server.tool_timeout, server.tool_timeout)
                : server.tool_timeout;
        const nativeTimeout = Number.isSafeInteger(timeout) && timeout > 0 ? timeout : undefined;
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (scope.signal?.aborted) abort();
        else scope.signal?.addEventListener('abort', abort, { once: true });
        effects.add(controller);
        try {
            if (disposed || controller.signal.aborted)
                throw new Error(t('agent.mcp.requestCancelled'));
            const response = await formatting.raceWithTimeoutAndSignal(
                mcp.callTool(server.id, name, args, nativeTimeout),
                nativeTimeout === undefined ? timeout : nativeTimeout + MCP_TIMEOUT_GUARD_GRACE_MS,
                controller.signal,
                timeout
            );
            if (disposed || controller.signal.aborted)
                throw new Error(t('agent.mcp.requestCancelled'));
            const result = formatting.formatMcpToolResponse(response);
            let attachments:
                | Awaited<ReturnType<typeof formatting.extractMcpToolAttachments>>
                | undefined;
            try {
                attachments = await formatting.extractMcpToolAttachments(response, {
                    toolCallId: scope.callId ?? name,
                    toolName: name,
                });
            } catch (error) {
                report('[MCP] Result attachment conversion failed', error);
            }
            if (disposed || controller.signal.aborted)
                throw new Error(t('agent.mcp.requestCancelled'));
            return { result, isError: response.is_error, attachments, sideEffect: 'completed' };
        } catch (error) {
            throw formatting.localizeNativeMcpTimeoutError(error, timeout);
        } finally {
            scope.signal?.removeEventListener('abort', abort);
            effects.delete(controller);
        }
    }
    return Object.freeze({
        connect,
        disconnect,
        refresh,
        async autoConnect(): Promise<void> {
            for (const server of await findEnabledMcpServers()) {
                requireLive();
                try {
                    await connect(server.id, 'background');
                } catch (error) {
                    diagnostics.error('[MCP] Auto-connect failed', { serverId: server.id }, error);
                }
            }
        },
        getStatus(serverId: number): McpConnectionEvent {
            return {
                serverId,
                status: status(serverId),
                error: statuses.get(serverId)?.error ?? null,
            };
        },
        subscribe(listener: (event: McpConnectionEvent) => void) {
            requireLive();
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async prepareTools(): Promise<readonly McpToolRegistration[]> {
            requireLive();
            const registrations: McpToolRegistration[] = [];
            for (const source of await findEnabledMcpServers()) {
                if (
                    status(source.id) !== 'connected' ||
                    implementations.get(source.id) !== implementationKey(source)
                )
                    continue;
                const server = structuredClone(source);
                const capturedGeneration = generation(server.id);
                const tools = await findEnabledMcpToolsByServerId(server.id);
                requireLive();
                if (
                    status(server.id) !== 'connected' ||
                    generation(server.id) !== capturedGeneration ||
                    implementations.get(server.id) !== implementationKey(server)
                )
                    continue;
                for (const tool of tools) {
                    const name = `mcp__${server.id}__${tool.name}`;
                    const originalName = tool.name;
                    const declaration: ToolDeclaration = {
                        name,
                        description:
                            tool.description ||
                            t('agent.mcp.toolDescriptionFallback', { toolName: tool.name }),
                        input_schema: parseMcpToolSchemaJson(
                            tool.input_schema
                        ) as ToolDeclaration['input_schema'],
                        adaptiveTimeoutCeilingMs: resolveAdaptiveTimeoutCeilingMs(
                            server.tool_timeout
                        ),
                    };
                    registrations.push({
                        name,
                        source: 'mcp',
                        prepare: async () => ({
                            declaration: structuredClone(declaration),
                            authorize: (scope) =>
                                isAuthorized(server, originalName, capturedGeneration, scope),
                            execute: (args, scope) =>
                                execute(server, originalName, capturedGeneration, args, scope),
                        }),
                    });
                }
            }
            return registrations;
        },
        dispose(): Promise<void> {
            if (disposal) return disposal;
            disposed = true;
            for (const controller of effects) controller.abort();
            listeners.clear();
            const pending = Promise.allSettled(
                [...ownedConnections].map((id) => mcp.disconnectServer(id))
            ).then((results) => {
                const failed = results.find((result) => result.status === 'rejected');
                if (failed?.status === 'rejected') throw failed.reason;
            });
            ownedConnections.clear();
            statuses.clear();
            generations.clear();
            implementations.clear();
            let timer: ReturnType<typeof setTimeout>;
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(t('agent.mcp.disconnectTimeout'))), 5000);
            });
            // The local deadline does not acknowledge native or remote shutdown.
            disposal = Promise.race([pending, timeout])
                .catch((error: unknown) => {
                    diagnostics.error('[MCP] Host cleanup failed', error);
                    throw error;
                })
                .finally(() => clearTimeout(timer));
            return disposal;
        },
    });
}

export type McpConnections = ReturnType<typeof createMcpConnections>;
