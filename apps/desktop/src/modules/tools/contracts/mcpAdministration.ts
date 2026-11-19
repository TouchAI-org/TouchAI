import { z } from 'zod';

export type DbTransportType = 'stdio' | 'sse' | 'http';

export interface McpServerSummary {
    id: number;
    name: string;
    enabled: number;
    version: string | null;
}

/** Privileged settings DTO: never part of the ordinary catalog. */
export interface McpServerEntity extends McpServerSummary {
    transport_type: DbTransportType;
    command: string | null;
    args: string | null;
    env: string | null;
    cwd: string | null;
    url: string | null;
    headers: string | null;
    tool_timeout: number;
    last_error: string | null;
    last_connected_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface McpServerCreateData {
    name: string;
    transport_type: DbTransportType;
    command?: string | null;
    args?: string | null;
    env?: string | null;
    cwd?: string | null;
    url?: string | null;
    headers?: string | null;
    enabled?: 0 | 1;
    tool_timeout?: number;
}
export type McpServerUpdateData = Partial<McpServerCreateData>;

export interface McpToolEntity {
    id: number;
    server_id: number;
    name: string;
    description: string | null;
    input_schema: string;
    enabled: number;
    created_at: string;
    updated_at: string;
}

export interface McpToolLogSummary {
    id: number;
    tool_call_id: string | null;
    tool_name: string;
    session_id: number | null;
    message_id: number;
    created_at: string;
    status: string;
    duration_ms: number | null;
    server_id: number | null;
    input_preview: string | null;
    output_length: number;
}

export interface McpToolLogEntity {
    id: number;
    server_id: number | null;
    tool_name: string;
    tool_call_id: string;
    session_id: number | null;
    message_id: number | null;
    iteration: number;
    input: string;
    output: string | null;
    status: 'pending' | 'success' | 'error' | 'timeout';
    duration_ms: number | null;
    error_message: string | null;
    created_at: string;
}

export interface McpCatalog {
    listServers(): Promise<McpServerSummary[]>;
    listTools(serverId: number): Promise<McpToolEntity[]>;
}

export interface McpAdministration {
    findAllMcpServers(): Promise<McpServerEntity[]>;
    createMcpServer(data: McpServerCreateData): Promise<McpServerEntity>;
    updateMcpServer(id: number, data: McpServerUpdateData): Promise<McpServerEntity | undefined>;
    deleteMcpServer(id: number): Promise<void>;
    findMcpToolsByServerId(serverId: number): Promise<McpToolEntity[]>;
    updateMcpTool(id: number, patch: { enabled?: 0 | 1 }): Promise<McpToolEntity | undefined>;
    findMcpToolLogSummariesByServerId(
        serverId: number,
        options?: { limit?: number; offset?: number }
    ): Promise<McpToolLogSummary[]>;
    findMcpToolLogById(id: number): Promise<McpToolLogEntity | undefined>;
}

export const mcpServerDraftSchema = z.strictObject({
    name: z.string().trim().min(1),
    transport_type: z.enum(['stdio', 'sse', 'http']),
    command: z.string().nullable().optional(),
    args: z.string().nullable().optional(),
    env: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    headers: z.string().nullable().optional(),
    enabled: z.union([z.literal(0), z.literal(1)]).optional(),
    tool_timeout: z.number().int().nonnegative().optional(),
});
