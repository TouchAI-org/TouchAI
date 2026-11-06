import type {
    BuiltInToolLogCreateData,
    BuiltInToolLogEntity,
    BuiltInToolLogUpdateData,
} from '../types';
import { createToolPart, findToolParts, updateToolPart } from './toolParts';
export const findBuiltInToolLogsByToolId = async (
    id: string,
    options?: { limit?: number; offset?: number }
) =>
    (await findToolParts(
        'builtin',
        { kind: 'tool_id', toolId: id },
        options
    )) as BuiltInToolLogEntity[];
export const createBuiltInToolLog = async (data: BuiltInToolLogCreateData) =>
    (await createToolPart('builtin', { ...data })) as BuiltInToolLogEntity;
export const updateBuiltInToolLogByCallId = async (id: string, data: BuiltInToolLogUpdateData) =>
    (await updateToolPart('builtin', { kind: 'tool_call_id', toolCallId: id }, { ...data })) as
        | BuiltInToolLogEntity
        | undefined;
