import { inject, type InjectionKey } from 'vue';

import type { BuiltInToolQueries } from '@/modules/tools/public';

export type {
    BuiltInToolEntity,
    BuiltInToolLogEntity,
    BuiltInToolLogStatus,
    BuiltInToolLogSummary,
    BuiltInToolQueries,
    BuiltInToolRiskLevel,
    BuiltInToolUpdateData,
    FindBuiltInToolLogsOptions,
} from '@/modules/tools/public';
export type ToolsAdministrationApi = BuiltInToolQueries;
export class ToolsCommandError extends Error {
    constructor(
        readonly code:
            | 'TOOLS_COMMAND_UNAVAILABLE'
            | 'TOOLS_COMMAND_UNCONFIRMED'
            | 'TOOLS_COMMAND_FAILED',
        readonly outcome: 'none' | 'unknown'
    ) {
        super(code);
        this.name = 'ToolsCommandError';
    }
}
export const toolsAdministrationApiKey: InjectionKey<ToolsAdministrationApi> = Symbol(
    'touchai.tools.administration'
);
export function useToolsAdministrationApi(): ToolsAdministrationApi {
    const api = inject(toolsAdministrationApiKey);
    if (!api) throw new ToolsCommandError('TOOLS_COMMAND_UNAVAILABLE', 'none');
    return api;
}
