import { eq } from 'drizzle-orm';

import { messageParts } from '../schema';
import type {
    BuiltInToolLogCreateData,
    BuiltInToolLogEntity,
    BuiltInToolLogUpdateData,
} from '../types';
import {
    createToolPart,
    findToolPartById,
    findToolParts,
    findToolPartSummaries,
    type ToolPartSummaryRow,
    updateToolPart,
} from './toolParts';

/** 列表展示用的内置工具日志摘要（不含完整 input/output）。 */
export type BuiltInToolLogSummary = ToolPartSummaryRow;

export const findBuiltInToolLogsByToolId = async (
    id: string,
    options?: { limit?: number; offset?: number }
) =>
    (await findToolParts(
        'builtin',
        eq(messageParts.tool_id, id),
        options
    )) as BuiltInToolLogEntity[];

/** 列表轻量投影：只读取展示字段与输入摘要。 */
export const findBuiltInToolLogSummariesByToolId = async (
    id: string,
    options?: { limit?: number; offset?: number }
): Promise<BuiltInToolLogSummary[]> =>
    await findToolPartSummaries('builtin', eq(messageParts.tool_id, id), options);

/** 展开时按主键读取完整日志正文。 */
export const findBuiltInToolLogById = async (id: number) =>
    (await findToolPartById('builtin', id)) as BuiltInToolLogEntity | undefined;

export const createBuiltInToolLog = async (data: BuiltInToolLogCreateData) =>
    (await createToolPart('builtin', { ...data })) as BuiltInToolLogEntity;
export const updateBuiltInToolLogByCallId = async (id: string, data: BuiltInToolLogUpdateData) =>
    (await updateToolPart('builtin', eq(messageParts.tool_call_id, id), { ...data })) as
        | BuiltInToolLogEntity
        | undefined;
