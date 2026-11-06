import type { McpToolLogCreateData, McpToolLogEntity, McpToolLogUpdateData } from '../types';
import { createToolPart, findToolParts, updateToolPart } from './toolParts';
export const findMcpToolLogsByServerId = async (
    id: number,
    options?: { limit?: number; offset?: number }
) =>
    (await findToolParts(
        'mcp',
        { kind: 'server_id', serverId: id },
        options
    )) as McpToolLogEntity[];
export const createMcpToolLog = async (data: McpToolLogCreateData) =>
    (await createToolPart('mcp', { ...data })) as McpToolLogEntity;
export const updateMcpToolLogByCallId = async (id: string, data: McpToolLogUpdateData) =>
    (await updateToolPart('mcp', { kind: 'tool_call_id', toolCallId: id }, { ...data })) as
        | McpToolLogEntity
        | undefined;
