import { z } from 'zod';

import { type ToolsAdministrationApi, ToolsCommandError } from '@/app/api/tools/administration';
import {
    ExternalAgentCommandError,
    type ExternalAgentEntity,
    type ExternalAgentsAdministrationApi,
} from '@/app/api/tools/externalAgents';
import { McpCommandError } from '@/app/api/tools/mcp';
import type { McpAdministration } from '@/app/api/tools/mcpAdministration';
import type { ExternalAgentAdministration } from '@/modules/tools/public';
import { mcpServerDraftSchema } from '@/modules/tools/public';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

const REQUEST_EVENT = 'tools:administration:request';
const REPLY_EVENT = 'tools:administration:reply';
const TIMEOUT_MS = 5_000;
const LIMIT = 16;
const id = z.number().int().positive();
const patch = z.strictObject({
    enabled: z.union([z.literal(0), z.literal(1)]).optional(),
    config_json: z.string().nullable().optional(),
});
const options = z
    .strictObject({
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
    })
    .optional();
const commands = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('list') }),
    z.strictObject({ operation: z.literal('update'), id, patch }),
    z.strictObject({ operation: z.literal('update-many'), ids: z.array(id), patch }),
    z.strictObject({ operation: z.literal('logs'), toolId: z.string().min(1), options }),
    z.strictObject({ operation: z.literal('summaries'), toolId: z.string().min(1), options }),
    z.strictObject({ operation: z.literal('log'), id }),
    z.strictObject({ operation: z.literal('mcp-servers') }),
    z.strictObject({ operation: z.literal('mcp-create'), data: mcpServerDraftSchema }),
    z.strictObject({
        operation: z.literal('mcp-update'),
        id,
        data: mcpServerDraftSchema.partial(),
    }),
    z.strictObject({ operation: z.literal('mcp-delete'), id }),
    z.strictObject({ operation: z.literal('mcp-tools'), id }),
    z.strictObject({
        operation: z.literal('mcp-tool-update'),
        id,
        patch: z.strictObject({ enabled: z.union([z.literal(0), z.literal(1)]).optional() }),
    }),
    z.strictObject({ operation: z.literal('mcp-summaries'), id, options }),
    z.strictObject({ operation: z.literal('mcp-log'), id }),
    z.strictObject({ operation: z.literal('external-agents-list') }),
    z.strictObject({
        operation: z.literal('external-agent-add'),
        url: z.string().trim().min(1).max(2048),
        allowLoopback: z.boolean(),
    }),
    z.strictObject({ operation: z.literal('external-agent-rediscover'), id }),
    z.strictObject({
        operation: z.literal('external-agent-update'),
        id,
        enabled: z.boolean(),
    }),
    z.strictObject({ operation: z.literal('external-agent-delete'), id }),
]);
type Command = z.infer<typeof commands>;
const requestSchema = z.strictObject({
    requestId: z.uuid(),
    from: z.literal('settings'),
    command: commands,
});
const toolSchema = z.object({
    id,
    tool_id: z.string(),
    display_name: z.string(),
    description: z.string().nullable(),
    enabled: z.number().int(),
    risk_level: z.enum(['low', 'medium', 'high']),
    config_json: z.string().nullable(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
});
const status = z.enum([
    'pending',
    'awaiting_approval',
    'approved',
    'rejected',
    'success',
    'error',
    'timeout',
    'cancelled',
]);
const logSchema = z.object({
    id,
    tool_id: z.string(),
    tool_call_id: z.string(),
    session_id: id.nullable(),
    message_id: id.nullable(),
    iteration: z.number().int(),
    input: z.string(),
    output: z.string().nullable(),
    status,
    approval_state: z.string().nullable(),
    approval_summary: z.string().nullable(),
    duration_ms: z.number().nullable(),
    error_message: z.string().nullable(),
    created_at: z.string(),
});
const summarySchema = z.object({
    id,
    tool_call_id: z.string().nullable(),
    tool_name: z.string(),
    session_id: id.nullable(),
    message_id: id,
    created_at: z.string(),
    status,
    duration_ms: z.number().nullable(),
    input_preview: z.string().nullable(),
    output_length: z.number().int().nonnegative(),
});
const mcpServerSchema = mcpServerDraftSchema.required().extend({
    id,
    enabled: z.number().int(),
    tool_timeout: z.number(),
    version: z.string().nullable(),
    last_error: z.string().nullable(),
    last_connected_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
});
const mcpToolSchema = z.object({
    id,
    server_id: id,
    name: z.string(),
    description: z.string().nullable(),
    input_schema: z.string(),
    enabled: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
});
const mcpLogSchema = logSchema
    .omit({ tool_id: true, approval_state: true, approval_summary: true })
    .extend({
        tool_name: z.string(),
        server_id: id.nullable(),
        status: z.enum(['pending', 'success', 'error', 'timeout']),
    });
const mcpSummarySchema = summarySchema.extend({ server_id: id.nullable(), status: z.string() });
const externalAgentSchema = z.object({
    id,
    name: z.string(),
    url: z.string().url(),
    protocol: z.literal('a2a'),
    enabled: z.union([z.literal(0), z.literal(1)]),
    last_discovered_at: z.string().nullable(),
    last_error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
});
const resultSchema = z.union([
    z.array(toolSchema),
    toolSchema,
    z.array(logSchema),
    logSchema,
    z.array(mcpSummarySchema),
    mcpSummarySchema,
    z.array(summarySchema),
    z.array(mcpServerSchema),
    mcpServerSchema,
    z.array(mcpToolSchema),
    mcpToolSchema,
    z.array(mcpLogSchema),
    mcpLogSchema,
    z.array(externalAgentSchema),
    externalAgentSchema,
    z.null(),
]);
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({ requestId: z.uuid(), ok: z.literal(true), result: resultSchema }),
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(false),
        code: z.enum([
            'TOOLS_COMMAND_UNAVAILABLE',
            'TOOLS_COMMAND_UNCONFIRMED',
            'TOOLS_COMMAND_FAILED',
        ]),
        outcome: z.enum(['none', 'unknown']),
    }),
]);
type Reply = z.infer<typeof replySchema>;

/** Configuration/history commands only; never registration, execution or decision settlement. */
export function createToolsAdministrationWindow(input: {
    label: string | null;
    signal: AbortSignal;
    queries?(signal: AbortSignal): Promise<ToolsAdministrationApi>;
    mcpQueries?(signal: AbortSignal): Promise<McpAdministration>;
    externalAgents?(signal: AbortSignal): Promise<ExternalAgentAdministration>;
    warn(code: string): void;
}) {
    const supported = input.label === 'main' || input.label === 'settings';
    const pending = new Map<string, (reply: Reply) => void>();
    const served = new Map<
        string,
        { command: string; completion: Promise<Reply>; completedAt?: number }
    >();
    let disposed = input.signal.aborted;
    let stop: (() => void) | undefined;
    let running = 0;
    function warn() {
        try {
            input.warn('TOOLS_COMMAND_FAILED');
        } catch {
            /* Passive diagnostics. */
        }
    }
    const failure = (requestId: string, error: ToolsCommandError): Reply => ({
        requestId,
        ok: false,
        code: error.code,
        outcome: error.outcome,
    });
    const externalAgentSummary = (row: {
        id: number;
        name: string;
        url: string;
        protocol: 'a2a';
        enabled: number;
        last_discovered_at: string | null;
        last_error: string | null;
        created_at: string;
        updated_at: string;
    }): ExternalAgentEntity => ({
        id: row.id,
        name: row.name,
        url: row.url,
        protocol: row.protocol,
        enabled: row.enabled,
        last_discovered_at: row.last_discovered_at,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
    });

    async function run(command: Command) {
        if (disposed || !input.queries || running >= LIMIT)
            throw new ToolsCommandError('TOOLS_COMMAND_UNAVAILABLE', 'none');
        running++;
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(new ToolsCommandError('TOOLS_COMMAND_UNCONFIRMED', 'unknown')),
            TIMEOUT_MS
        );
        const combined = combineAbortSignals([input.signal, deadline.signal]);
        try {
            return await awaitAbortable(async () => {
                const mcpCommand = command.operation.startsWith('mcp-');
                const externalAgentCommand = command.operation.startsWith('external-agent');
                const queries =
                    mcpCommand || externalAgentCommand
                        ? undefined
                        : await input.queries!(combined.signal);
                const mcp = mcpCommand ? await input.mcpQueries?.(combined.signal) : undefined;
                const externalAgents = externalAgentCommand
                    ? await input.externalAgents?.(combined.signal)
                    : undefined;
                if (mcpCommand && !mcp)
                    throw new ToolsCommandError('TOOLS_COMMAND_UNAVAILABLE', 'none');
                if (externalAgentCommand && !externalAgents)
                    throw new ToolsCommandError('TOOLS_COMMAND_UNAVAILABLE', 'none');
                combined.signal.throwIfAborted();
                let result;
                switch (command.operation) {
                    case 'list':
                        result = await queries!.findAllBuiltInTools();
                        break;
                    case 'update':
                        result = await queries!.updateBuiltInTool(command.id, command.patch);
                        break;
                    case 'update-many':
                        result = await queries!.updateBuiltInTools(command.ids, command.patch);
                        break;
                    case 'logs':
                        result = await queries!.findBuiltInToolLogsByToolId(
                            command.toolId,
                            command.options
                        );
                        break;
                    case 'summaries':
                        result = await queries!.findBuiltInToolLogSummariesByToolId(
                            command.toolId,
                            command.options
                        );
                        break;
                    case 'log':
                        result = await queries!.findBuiltInToolLogById(command.id);
                        break;
                    case 'mcp-servers':
                        result = await mcp!.findAllMcpServers();
                        break;
                    case 'mcp-create':
                        result = await mcp!.createMcpServer(command.data);
                        break;
                    case 'mcp-update':
                        result = await mcp!.updateMcpServer(command.id, command.data);
                        break;
                    case 'mcp-delete':
                        await mcp!.deleteMcpServer(command.id);
                        result = null;
                        break;
                    case 'mcp-tools':
                        result = await mcp!.findMcpToolsByServerId(command.id);
                        break;
                    case 'mcp-tool-update':
                        result = await mcp!.updateMcpTool(command.id, command.patch);
                        break;
                    case 'mcp-summaries':
                        result = await mcp!.findMcpToolLogSummariesByServerId(
                            command.id,
                            command.options
                        );
                        break;
                    case 'mcp-log':
                        result = await mcp!.findMcpToolLogById(command.id);
                        break;
                    case 'external-agents-list':
                        result = (await externalAgents!.findAll()).map(externalAgentSummary);
                        break;
                    case 'external-agent-add':
                        result = externalAgentSummary(
                            await externalAgents!.add({
                                url: command.url,
                                allowLoopback: command.allowLoopback,
                            })
                        );
                        break;
                    case 'external-agent-rediscover':
                        result = externalAgentSummary(await externalAgents!.rediscover(command.id));
                        break;
                    case 'external-agent-update': {
                        const updated = await externalAgents!.updateEnabled(
                            command.id,
                            command.enabled
                        );
                        result = updated ? externalAgentSummary(updated) : null;
                        break;
                    }
                    case 'external-agent-delete':
                        await externalAgents!.delete(command.id);
                        result = null;
                        break;
                }
                return resultSchema.parse(result ?? null);
            }, combined.signal);
        } catch (error) {
            if (error instanceof ToolsCommandError) throw error;
            throw new ToolsCommandError('TOOLS_COMMAND_FAILED', 'unknown');
        } finally {
            combined.dispose();
            clearTimeout(timer);
            running--;
        }
    }

    async function serve(payload: unknown) {
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success || disposed) return;
        const request = parsed.data;
        const now = Date.now();
        for (const [key, value] of served)
            if (value.completedAt !== undefined && now - value.completedAt >= 300_000)
                served.delete(key);
        const command = JSON.stringify(request.command);
        let entry = served.get(request.requestId);
        if (entry && entry.command !== command) return;
        if (!entry) {
            if (served.size >= 64) {
                for (const [key, value] of served) {
                    if (value.completedAt !== undefined) {
                        served.delete(key);
                        break;
                    }
                }
            }
            if (served.size >= 64) {
                await emitWindowEvent(
                    request.from,
                    REPLY_EVENT,
                    failure(
                        request.requestId,
                        new ToolsCommandError('TOOLS_COMMAND_UNAVAILABLE', 'none')
                    )
                ).catch(warn);
                return;
            }
            entry = {
                command,
                completion: run(request.command).then(
                    (result): Reply => ({ requestId: request.requestId, ok: true, result }),
                    (error: ToolsCommandError) => failure(request.requestId, error)
                ),
            };
            served.set(request.requestId, entry);
            const current = entry;
            void entry.completion.then(() => {
                current.completedAt = Date.now();
            });
        }
        const reply = await entry.completion;
        if (!disposed) await emitWindowEvent(request.from, REPLY_EVENT, reply).catch(warn);
    }

    const ready = supported
        ? listenWindowEvent(
              input.label!,
              input.label === 'main' ? REQUEST_EVENT : REPLY_EVENT,
              (payload) => {
                  if (input.label === 'main') {
                      void serve(payload).catch(warn);
                      return;
                  }
                  const parsed = replySchema.safeParse(payload);
                  if (parsed.success) pending.get(parsed.data.requestId)?.(parsed.data);
              }
          ).then((unlisten) => {
              if (disposed) unlisten();
              else stop = unlisten;
          })
        : Promise.resolve();
    void ready.catch(warn);

    async function request(command: Command) {
        if (
            disposed ||
            !supported ||
            !commands.safeParse(command).success ||
            pending.size >= LIMIT
        ) {
            throw new ToolsCommandError('TOOLS_COMMAND_UNAVAILABLE', 'none');
        }
        if (input.label === 'main') return run(command);
        const requestId = crypto.randomUUID();
        return new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
            const finish = (reply: Reply) => {
                if (!pending.delete(requestId)) return;
                clearTimeout(timer);
                if (reply.ok) resolve(reply.result);
                else reject(new ToolsCommandError(reply.code, reply.outcome));
            };
            const timer = setTimeout(
                () =>
                    finish(
                        failure(
                            requestId,
                            new ToolsCommandError('TOOLS_COMMAND_UNCONFIRMED', 'unknown')
                        )
                    ),
                TIMEOUT_MS
            );
            pending.set(requestId, finish);
            void ready
                .then(async () => {
                    if (pending.has(requestId))
                        await emitWindowEvent('main', REQUEST_EVENT, {
                            requestId,
                            from: 'settings',
                            command,
                        });
                })
                .catch(() =>
                    finish(
                        failure(
                            requestId,
                            new ToolsCommandError('TOOLS_COMMAND_UNAVAILABLE', 'none')
                        )
                    )
                );
        });
    }
    const api = Object.freeze<ToolsAdministrationApi>({
        findAllBuiltInTools: async () =>
            z.array(toolSchema).parse(await request({ operation: 'list' })),
        updateBuiltInTool: async (id, patch) =>
            toolSchema.nullable().parse(await request({ operation: 'update', id, patch })) ??
            undefined,
        updateBuiltInTools: async (ids, patch) =>
            z.array(toolSchema).parse(await request({ operation: 'update-many', ids, patch })),
        findBuiltInToolLogsByToolId: async (toolId, options) =>
            z.array(logSchema).parse(await request({ operation: 'logs', toolId, options })),
        findBuiltInToolLogSummariesByToolId: async (toolId, options) =>
            z
                .array(summarySchema)
                .parse(await request({ operation: 'summaries', toolId, options })),
        findBuiltInToolLogById: async (id) =>
            logSchema.nullable().parse(await request({ operation: 'log', id })) ?? undefined,
    });
    async function requestMcp(command: Command) {
        try {
            return await request(command);
        } catch (error) {
            if (error instanceof ToolsCommandError)
                throw new McpCommandError(
                    error.code === 'TOOLS_COMMAND_UNAVAILABLE'
                        ? 'MCP_COMMAND_UNAVAILABLE'
                        : error.code === 'TOOLS_COMMAND_UNCONFIRMED'
                          ? 'MCP_COMMAND_UNCONFIRMED'
                          : 'MCP_COMMAND_FAILED',
                    error.outcome
                );
            throw new McpCommandError('MCP_COMMAND_FAILED', 'unknown');
        }
    }
    const mcpApi = Object.freeze<McpAdministration>({
        findAllMcpServers: async () =>
            z.array(mcpServerSchema).parse(await requestMcp({ operation: 'mcp-servers' })),
        createMcpServer: async (data) =>
            mcpServerSchema.parse(await requestMcp({ operation: 'mcp-create', data })),
        updateMcpServer: async (id, data) =>
            mcpServerSchema
                .nullable()
                .parse(await requestMcp({ operation: 'mcp-update', id, data })) ?? undefined,
        deleteMcpServer: async (id) => {
            await requestMcp({ operation: 'mcp-delete', id });
        },
        findMcpToolsByServerId: async (id) =>
            z.array(mcpToolSchema).parse(await requestMcp({ operation: 'mcp-tools', id })),
        updateMcpTool: async (id, patch) =>
            mcpToolSchema
                .nullable()
                .parse(await requestMcp({ operation: 'mcp-tool-update', id, patch })) ?? undefined,
        findMcpToolLogSummariesByServerId: async (id, options) =>
            z
                .array(mcpSummarySchema)
                .parse(await requestMcp({ operation: 'mcp-summaries', id, options })),
        findMcpToolLogById: async (id) =>
            mcpLogSchema.nullable().parse(await requestMcp({ operation: 'mcp-log', id })) ??
            undefined,
    });
    async function requestExternalAgent(command: Command) {
        try {
            return await request(command);
        } catch (error) {
            if (error instanceof ToolsCommandError)
                throw new ExternalAgentCommandError(
                    error.code === 'TOOLS_COMMAND_UNAVAILABLE'
                        ? 'EXTERNAL_AGENT_COMMAND_UNAVAILABLE'
                        : error.code === 'TOOLS_COMMAND_UNCONFIRMED'
                          ? 'EXTERNAL_AGENT_COMMAND_UNCONFIRMED'
                          : 'EXTERNAL_AGENT_COMMAND_FAILED',
                    error.outcome
                );
            throw new ExternalAgentCommandError('EXTERNAL_AGENT_COMMAND_FAILED', 'unknown');
        }
    }
    const externalAgentsApi = Object.freeze<ExternalAgentsAdministrationApi>({
        findAll: async () =>
            z
                .array(externalAgentSchema)
                .parse(await requestExternalAgent({ operation: 'external-agents-list' })),
        add: async (input: { url: string; allowLoopback: boolean }) =>
            externalAgentSchema.parse(
                await requestExternalAgent({
                    operation: 'external-agent-add',
                    url: input.url,
                    allowLoopback: input.allowLoopback,
                })
            ),
        rediscover: async (id: number) =>
            externalAgentSchema.parse(
                await requestExternalAgent({ operation: 'external-agent-rediscover', id })
            ),
        updateEnabled: async (id: number, enabled: boolean) =>
            externalAgentSchema.nullable().parse(
                await requestExternalAgent({
                    operation: 'external-agent-update',
                    id,
                    enabled,
                })
            ) ?? undefined,
        delete: async (id: number) => {
            await requestExternalAgent({ operation: 'external-agent-delete', id });
        },
    });
    function dispose() {
        if (disposed) return;
        disposed = true;
        stop?.();
        stop = undefined;
        for (const [requestId, finish] of [...pending])
            finish(
                failure(requestId, new ToolsCommandError('TOOLS_COMMAND_UNCONFIRMED', 'unknown'))
            );
        served.clear();
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, mcpApi, externalAgentsApi, ready, dispose });
}
