import {
    findBuiltInToolLogById,
    findBuiltInToolLogsByToolId,
    findBuiltInToolLogSummariesByToolId,
} from '@/database/queries/builtInToolLogs';
import {
    findAllBuiltInTools,
    updateBuiltInTool,
    updateBuiltInTools,
} from '@/database/queries/builtInTools';
import { findBuiltInToolById } from '@/database/queries/builtInTools';

import type {
    BuiltInToolEntity,
    BuiltInToolLogStatus,
    BuiltInToolQueries,
    BuiltInToolUpdateData,
} from '../contracts/administration';

function projectTool(row: BuiltInToolEntity): BuiltInToolEntity {
    return {
        id: row.id,
        tool_id: row.tool_id,
        display_name: row.display_name,
        description: row.description,
        enabled: row.enabled,
        risk_level: row.risk_level,
        config_json: row.config_json,
        last_used_at: row.last_used_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

/** Administration shares the registry's existing rows, never a second registration map. */
export function createBuiltinAdministration(): BuiltInToolQueries {
    async function requireTool(id: number) {
        if (!Number.isSafeInteger(id) || id <= 0 || !(await findBuiltInToolById(id)))
            throw new Error('TOOL_NOT_FOUND');
    }
    function validatePatch(patch: BuiltInToolUpdateData) {
        if (
            Object.keys(patch).some((key) => key !== 'enabled' && key !== 'config_json') ||
            (patch.enabled !== undefined && patch.enabled !== 0 && patch.enabled !== 1) ||
            (patch.config_json !== undefined &&
                patch.config_json !== null &&
                typeof patch.config_json !== 'string')
        ) {
            throw new Error('TOOL_CONFIGURATION_INVALID');
        }
    }
    return Object.freeze<BuiltInToolQueries>({
        async findAllBuiltInTools() {
            return (await findAllBuiltInTools()).map(projectTool);
        },
        async updateBuiltInTool(id, patch) {
            validatePatch(patch);
            await requireTool(id);
            const row = await updateBuiltInTool(id, patch);
            return row ? projectTool(row) : undefined;
        },
        async updateBuiltInTools(ids, patch) {
            validatePatch(patch);
            for (const id of ids) await requireTool(id);
            return (await updateBuiltInTools(ids, patch)).map(projectTool);
        },
        findBuiltInToolLogsByToolId,
        async findBuiltInToolLogSummariesByToolId(toolId, options) {
            return (await findBuiltInToolLogSummariesByToolId(toolId, options)).map((row) => ({
                id: row.id,
                tool_call_id: row.tool_call_id,
                tool_name: row.tool_name,
                session_id: row.session_id,
                message_id: row.message_id,
                created_at: row.created_at,
                status: row.status as BuiltInToolLogStatus,
                duration_ms: row.duration_ms,
                input_preview: row.input_preview,
                output_length: row.output_length,
            }));
        },
        findBuiltInToolLogById,
    });
}
