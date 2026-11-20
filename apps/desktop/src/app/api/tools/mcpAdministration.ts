import { inject, type InjectionKey } from 'vue';

import type { McpAdministration } from '@/modules/tools/public';

export type {
    DbTransportType,
    McpAdministration,
    McpServerCreateData,
    McpServerEntity,
    McpServerUpdateData,
    McpToolEntity,
    McpToolLogEntity,
    McpToolLogSummary,
} from '@/modules/tools/public';

export const mcpAdministrationApiKey: InjectionKey<McpAdministration> = Symbol(
    'touchai.tools.mcp.administration'
);
export function useMcpAdministrationApi(): McpAdministration {
    const api = inject(mcpAdministrationApiKey);
    if (!api) throw new Error('MCP_COMMAND_UNAVAILABLE');
    return api;
}
