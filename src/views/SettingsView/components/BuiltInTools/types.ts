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

const BUILT_IN_TOOL_HIDDEN_IN_SETTINGS_IDS = new Set(['visualize_read_me']);

export function getBuiltInToolSummary(toolId: string, description?: string | null): string {
    if (toolId === 'bash') {
        return '执行终端命令';
    }

    if (toolId === 'file_search') {
        return '搜索本机文件';
    }

    if (toolId === 'read') {
        return '读取本地文件或目录，支持图片与 PDF';
    }

    if (toolId === 'setting') {
        return '读取和修改应用设置';
    }

    if (toolId === 'web_fetch') {
        return '抓取网页并提取易读文本';
    }

    if (toolId === 'upgrade_model') {
        return '升级当前请求模型';
    }

    if (toolId === 'show_widget') {
        return '聊天内联可交互可视化';
    }

    if (toolId === 'visualize_read_me') {
        return '读取 ShowWidget 规范';
    }

    return description?.trim() || '暂无描述';
}

export function isBuiltInToolVisibleInSettings(toolId: string): boolean {
    return !BUILT_IN_TOOL_HIDDEN_IN_SETTINGS_IDS.has(toolId);
}

export function usesBuiltInToolEmptyConfig(toolId: string): boolean {
    return BUILT_IN_TOOL_EMPTY_CONFIG_IDS.has(toolId);
}

export function formatToolLastUsed(value: string | null): string {
    if (!value) {
        return '尚未调用';
    }

    return new Date(value).toLocaleString('zh-CN');
}

export async function loadBuiltInToolQueries(): Promise<BuiltInToolQueries> {
    return (await import('@database/queries')) as unknown as BuiltInToolQueries;
}
