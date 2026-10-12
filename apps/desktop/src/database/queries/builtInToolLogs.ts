import { eq } from 'drizzle-orm';

import { messageParts, messages } from '../schema';
import type {
    BuiltInToolLogCreateData,
    BuiltInToolLogEntity,
    BuiltInToolLogUpdateData,
} from '../types';
import {
    countToolParts,
    createToolPart,
    findToolParts,
    toolData,
    updateToolPart,
} from './toolParts';
export const findBuiltInToolLogsByToolId = async (
    id: string,
    options?: { limit?: number; offset?: number }
) =>
    (await findToolParts(
        'builtin',
        eq(toolData('tool_id'), id),
        options
    )) as BuiltInToolLogEntity[];
export const findBuiltInToolLogsBySessionId = async (id: number) =>
    (await findToolParts('builtin', eq(messages.session_id, id))) as BuiltInToolLogEntity[];
export const findBuiltInToolLogByCallId = async (id: string) =>
    (await findToolParts('builtin', eq(messageParts.tool_call_id, id)))[0] as
        | BuiltInToolLogEntity
        | undefined;
export const createBuiltInToolLog = async (data: BuiltInToolLogCreateData) =>
    (await createToolPart('builtin', { ...data })) as BuiltInToolLogEntity;
export const updateBuiltInToolLogByCallId = async (id: string, data: BuiltInToolLogUpdateData) =>
    (await updateToolPart('builtin', eq(messageParts.tool_call_id, id), { ...data })) as
        | BuiltInToolLogEntity
        | undefined;
export const countBuiltInToolLogs = async () => countToolParts('builtin');
