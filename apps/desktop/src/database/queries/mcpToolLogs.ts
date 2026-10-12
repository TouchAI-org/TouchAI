import { and, eq } from 'drizzle-orm';

import { db } from '../index';
import { messageParts, messages } from '../schema';
import type { McpToolLogCreateData, McpToolLogEntity, McpToolLogUpdateData } from '../types';
import {
    countToolParts,
    createToolPart,
    findToolParts,
    toolData,
    updateToolPart,
} from './toolParts';
export const findMcpToolLogsBySessionId = async (id: number) =>
    (await findToolParts('mcp', eq(messages.session_id, id))) as McpToolLogEntity[];
export const findMcpToolLogsByServerId = async (
    id: number,
    options?: { limit?: number; offset?: number }
) => (await findToolParts('mcp', eq(toolData('server_id'), id), options)) as McpToolLogEntity[];
export const findMcpToolLogByCallId = async (id: string) =>
    (await findToolParts('mcp', eq(messageParts.tool_call_id, id)))[0] as
        | McpToolLogEntity
        | undefined;
export const findMcpToolLogById = async (id: number) =>
    (await findToolParts('mcp', eq(messageParts.id, id)))[0] as McpToolLogEntity | undefined;
export const findMcpToolLogsByMessageId = async (id: number) =>
    (await findToolParts('mcp', eq(messageParts.message_id, id))) as McpToolLogEntity[];
export const findMcpToolLogsBySessionIdAndIteration = async (id: number, iteration: number) =>
    (await findToolParts(
        'mcp',
        and(eq(messages.session_id, id), eq(toolData('iteration'), iteration))
    )) as McpToolLogEntity[];
export const createMcpToolLog = async (data: McpToolLogCreateData) =>
    (await createToolPart('mcp', { ...data })) as McpToolLogEntity;
export const updateMcpToolLog = async (id: number, data: McpToolLogUpdateData) =>
    (await updateToolPart('mcp', eq(messageParts.id, id), { ...data })) as
        | McpToolLogEntity
        | undefined;
export const updateMcpToolLogByCallId = async (id: string, data: McpToolLogUpdateData) =>
    (await updateToolPart('mcp', eq(messageParts.tool_call_id, id), { ...data })) as
        | McpToolLogEntity
        | undefined;
export const deleteMcpToolLog = async (id: number): Promise<void> => {
    await db
        .delete(messageParts)
        .where(
            and(
                eq(messageParts.id, id),
                eq(messageParts.type, 'tool_call'),
                eq(messageParts.tool_kind, 'mcp')
            )
        )
        .run();
};
export const deleteMcpToolLogsBySessionId = async (id: number): Promise<void> => {
    const parts = await findMcpToolLogsBySessionId(id);
    for (const part of parts) await deleteMcpToolLog(part.id);
};
export const countMcpToolLogs = async () => countToolParts('mcp');
export const countMcpToolLogsBySessionId = async (id: number) =>
    countToolParts('mcp', eq(messages.session_id, id));
