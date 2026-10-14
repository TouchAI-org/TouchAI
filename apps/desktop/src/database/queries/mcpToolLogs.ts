import { eq } from 'drizzle-orm';

import { messageParts } from '../schema';
import type { McpToolLogCreateData, McpToolLogEntity, McpToolLogUpdateData } from '../types';
import { createToolPart, findToolParts, toolData, updateToolPart } from './toolParts';
export const findMcpToolLogsByServerId = async (
    id: number,
    options?: { limit?: number; offset?: number }
) => (await findToolParts('mcp', eq(toolData('server_id'), id), options)) as McpToolLogEntity[];
export const createMcpToolLog = async (data: McpToolLogCreateData) =>
    (await createToolPart('mcp', { ...data })) as McpToolLogEntity;
export const updateMcpToolLogByCallId = async (id: string, data: McpToolLogUpdateData) =>
    (await updateToolPart('mcp', eq(messageParts.tool_call_id, id), { ...data })) as
        | McpToolLogEntity
        | undefined;
