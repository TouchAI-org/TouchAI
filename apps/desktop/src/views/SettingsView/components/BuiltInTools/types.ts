// Copyright (c) 2026. 千诚. Licensed under GPL v3

export type { BashApprovalMode, BashToolConfig } from '@/services/BuiltInToolService/tools/bash';
export {
    DEFAULT_BASH_TOOL_CONFIG,
    parseBashToolConfig,
} from '@/services/BuiltInToolService/tools/bash';
export {
    parseUpgradeModelToolConfig,
    type UpgradeModelToolConfig,
} from '@/services/BuiltInToolService/tools/upgradeModel/config';
export {
    DEFAULT_DESKTOP_CONTEXT_TOOL_CONFIG,
    type DesktopContextToolConfig,
    parseDesktopContextToolConfig,
    serializeDesktopContextToolConfig,
} from '@/services/BuiltInToolService/tools/desktopContext/config';
import { t } from '@/i18n';
import { formatDateTime } from '@/i18n/format';

export type BuiltInToolRiskLevel = 'low' | 'medium' | 'high';
export type BuiltInToolLogStatus =
    | 'pending'
    | 'awaiting_approval'
    | 'approved'
    | 'rejected'
    | 'success'
    | 'error'
    | 'timeout';
export interface BuiltInToolEntity {
    id: number;
    tool_id: string;
    display_name: string;
    description: string | null;
    enabled: number;
    risk_level: BuiltInToolRiskLevel;
    config_json: string | null;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface BuiltInToolLogEntity {
    id: number;
    tool_id: string;
    tool_call_id: string;
    session_id: number | null;
    message_id: number | null;
    iteration: number;
    input: string;
    output: string | null;
    status: BuiltInToolLogStatus;
    approval_state: string | null;
    approval_summary: string | null;
    duration_ms: number | null;
    error_message: string | null;
    created_at: string;
}

export interface BuiltInToolUpdateData {
    enabled?: number;
    config_json?: string | null;
}

export interface FindBuiltInToolLogsOptions {
    limit?: number;
    offset?: number;
}

export interface BuiltInToolQueries {
    findAllBuiltInTools: () => Promise<BuiltInToolEntity[]>;
    updateBuiltInTool: (
        id: number,
        patch: BuiltInToolUpdateData
    ) => Promise<BuiltInToolEntity | undefined>;
    findBuiltInToolLogsByToolId: (
        toolId: string,
        options?: FindBuiltInToolLogsOptions
    ) => Promise<BuiltInToolLogEntity[]>;
}

const BUILT_IN_TOOL_EMPTY_CONFIG_IDS = new Set([
    'file_search',
    'read',
    'setting',
    'web_fetch',
    'show_widget',
    'visualize_read_me',
]);

const BUILT_IN_TOOL_HIDDEN_IN_SETTINGS_IDS = new Set(['visualize_read_me', 'ask_user_question']);

export function getBuiltInToolSummary(toolId: string, description?: string | null): string {
    if (toolId === 'bash') {
        return t('settings.builtInTools.summary.bash');
    }

    if (toolId === 'file_search') {
        return t('settings.builtInTools.summary.fileSearch');
    }

    if (toolId === 'read') {
        return t('settings.builtInTools.summary.read');
    }

    if (toolId === 'setting') {
        return t('settings.builtInTools.summary.setting');
    }

    if (toolId === 'web_fetch') {
        return t('settings.builtInTools.summary.webFetch');
    }

    if (toolId === 'get_desktop_context') {
        return t('settings.builtInTools.summary.desktopContext');
    }

    if (toolId === 'upgrade_model') {
        return t('settings.builtInTools.summary.upgradeModel');
    }

    if (toolId === 'show_widget') {
        return t('settings.builtInTools.summary.showWidget');
    }

    if (toolId === 'visualize_read_me') {
        return t('settings.builtInTools.summary.visualizeReadMe');
    }

    return description?.trim() || t('settings.builtInTools.summary.fallback');
}

export function isBuiltInToolVisibleInSettings(toolId: string): boolean {
    return !BUILT_IN_TOOL_HIDDEN_IN_SETTINGS_IDS.has(toolId);
}

export function usesBuiltInToolEmptyConfig(toolId: string): boolean {
    return BUILT_IN_TOOL_EMPTY_CONFIG_IDS.has(toolId);
}

export function formatToolLastUsed(value: string | null): string {
    if (!value) {
        return t('settings.builtInTools.lastUsed.never');
    }

    return formatDateTime(value);
}

export async function loadBuiltInToolQueries(): Promise<BuiltInToolQueries> {
    return (await import('@database/queries')) as unknown as BuiltInToolQueries;
}
