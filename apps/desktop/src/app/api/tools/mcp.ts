import { inject, type InjectionKey } from 'vue';

import type { McpCatalog } from '@/modules/tools/public';
export type { McpServerSummary, McpToolEntity } from '@/modules/tools/public';

export interface McpStatus {
    serverId: number;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error: string | null;
}

export interface McpManagementApi extends McpCatalog {
    connectServer(serverId: number): Promise<void>;
    disconnectServer(serverId: number): Promise<void>;
    refreshAllServerStatuses(): Promise<McpStatus[]>;
}

export class McpCommandError extends Error {
    constructor(
        readonly code: 'MCP_COMMAND_UNCONFIRMED' | 'MCP_COMMAND_FAILED' | 'MCP_COMMAND_UNAVAILABLE',
        readonly outcome: 'none' | 'unknown'
    ) {
        super(code);
        this.name = 'McpCommandError';
    }
}

export const mcpApiKey: InjectionKey<McpManagementApi> = Symbol('touchai.tools.mcp');

export function useMcpApi(): McpManagementApi {
    const api = inject(mcpApiKey);
    if (!api) throw new McpCommandError('MCP_COMMAND_UNAVAILABLE', 'none');
    return api;
}
