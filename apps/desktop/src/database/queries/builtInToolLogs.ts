import { eq } from 'drizzle-orm';

import { messageParts } from '../schema';
import type {
    BuiltInToolLogCreateData,
    BuiltInToolLogEntity,
    BuiltInToolLogUpdateData,
} from '../types';
import { createToolPart, findToolParts, toolData, updateToolPart } from './toolParts';
export const findBuiltInToolLogsByToolId = async (
    id: string,
    options?: { limit?: number; offset?: number }
) =>
    (await findToolParts(
        'builtin',
        eq(toolData('tool_id'), id),
        options
    )) as BuiltInToolLogEntity[];
export const createBuiltInToolLog = async (data: BuiltInToolLogCreateData) =>
    (await createToolPart('builtin', { ...data })) as BuiltInToolLogEntity;
export const updateBuiltInToolLogByCallId = async (id: string, data: BuiltInToolLogUpdateData) =>
    (await updateToolPart('builtin', eq(messageParts.tool_call_id, id), { ...data })) as
        | BuiltInToolLogEntity
        | undefined;
