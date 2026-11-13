import type { McpToolLogCreateData, McpToolLogEntity, McpToolLogUpdateData } from '../types';
import {
    createToolPart,
    findToolPartById,
    findToolParts,
    findToolPartSummaries,
    type ToolPartSummaryRow,
    updateToolPart,
} from './toolParts';

/** 列表展示用的 MCP 日志摘要（不含完整 input/output）。 */
export type McpToolLogSummary = ToolPartSummaryRow;

export const findMcpToolLogsByServerId = async (
    id: number,
    options?: { limit?: number; offset?: number }
) =>
    (await findToolParts(
        'mcp',
        { kind: 'server_id', serverId: id },
        options
    )) as McpToolLogEntity[];

/** 列表轻量投影：只读取展示字段与输入摘要。 */
export const findMcpToolLogSummariesByServerId = async (
    id: number,
    options?: { limit?: number; offset?: number }
): Promise<McpToolLogSummary[]> =>
    await findToolPartSummaries('mcp', { kind: 'server_id', serverId: id }, options);

/** 展开时按主键读取完整日志正文。 */
export const findMcpToolLogById = async (id: number) =>
    (await findToolPartById('mcp', id)) as McpToolLogEntity | undefined;
export const createMcpToolLog = async (data: McpToolLogCreateData) =>
    (await createToolPart('mcp', { ...data })) as McpToolLogEntity;
export const updateMcpToolLogById = async (id: number, data: McpToolLogUpdateData) =>
    (await updateToolPart('mcp', id, data)) as McpToolLogEntity | undefined;
export const updateMcpToolLogByCallId = async (id: string, data: McpToolLogUpdateData) =>
    (await updateToolPart('mcp', { kind: 'tool_call_id', toolCallId: id }, { ...data })) as
        | McpToolLogEntity
        | undefined;
