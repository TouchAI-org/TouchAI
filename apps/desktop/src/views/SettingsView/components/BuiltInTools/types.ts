// Copyright (c) 2026. 千诚. Licensed under GPL v3

export type { BashApprovalMode, BashToolConfig } from '@/app/api/tools/configuration';
export { DEFAULT_BASH_TOOL_CONFIG, parseBashToolConfig } from '@/app/api/tools/configuration';
export {
    type BrowserAutomationMode,
    type BrowserAutomationToolConfig,
    DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG,
    getBrowserAutomationStartupUrlError,
    parseBrowserAutomationToolConfig,
    serializeBrowserAutomationToolConfig,
} from '@/app/api/tools/configuration';
export {
    parseReadConversationToolConfig,
    parseSearchConversationToolConfig,
    parseUpgradeModelToolConfig,
    type ReadConversationToolConfig,
    type SearchConversationToolConfig,
    serializeReadConversationToolConfig,
    serializeSearchConversationToolConfig,
    type UpgradeModelToolConfig,
} from '@/app/api/tools/configuration';
import type { BuiltInToolEntity } from '@/app/api/tools/administration';
import { t } from '@/i18n';
import { formatDateTime } from '@/i18n/format';
export type {
    BuiltInToolEntity,
    BuiltInToolLogEntity,
    BuiltInToolLogStatus,
    BuiltInToolLogSummary,
    BuiltInToolQueries,
    BuiltInToolRiskLevel,
    BuiltInToolUpdateData,
    FindBuiltInToolLogsOptions,
} from '@/app/api/tools/administration';

const BUILT_IN_TOOL_EMPTY_CONFIG_IDS = new Set([
    'file_search',
    'read',
    'setting',
    'web_search',
    'web_fetch',
    'browser',
    'computer_use',
    'show_widget',
    'visualize_read_me',
    'ask_user_question',
    'activate_skill',
]);

const BUILT_IN_TOOL_HIDDEN_IN_SETTINGS_IDS = new Set(['web_search', 'visualize_read_me']);
const BROWSER_AUTOMATION_TOOL_IDS = new Set(['browser']);

export function getBuiltInToolDisplayName(tool: BuiltInToolEntity): string {
    return tool.display_name;
}

export function getBuiltInToolSummary(toolId: string, description?: string | null): string {
    if (toolId === 'computer_use') {
        return t('settings.builtInTools.summary.computerUse');
    }

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

    if (toolId === 'web_search') {
        return t('settings.builtInTools.summary.webSearch');
    }

    if (toolId === 'upgrade_model') {
        return t('settings.builtInTools.summary.upgradeModel');
    }

    if (isBrowserAutomationToolId(toolId)) {
        return t('settings.builtInTools.summary.browserAutomation');
    }

    if (toolId === 'show_widget') {
        return t('settings.builtInTools.summary.showWidget');
    }

    if (toolId === 'visualize_read_me') {
        return t('settings.builtInTools.summary.visualizeReadMe');
    }

    if (toolId === 'ask_user_question') {
        return t('settings.builtInTools.summary.askUserQuestion');
    }

    if (toolId === 'activate_skill') {
        return t('settings.builtInTools.summary.activateSkill');
    }

    if (toolId === 'search_conversation') {
        return t('settings.builtInTools.summary.searchConversation');
    }

    if (toolId === 'read_conversation') {
        return t('settings.builtInTools.summary.readConversation');
    }

    return description?.trim() || t('settings.builtInTools.summary.fallback');
}

export function isBuiltInToolVisibleInSettings(toolId: string): boolean {
    return !BUILT_IN_TOOL_HIDDEN_IN_SETTINGS_IDS.has(toolId);
}

export function isBrowserAutomationToolId(toolId: string): boolean {
    return BROWSER_AUTOMATION_TOOL_IDS.has(toolId);
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
