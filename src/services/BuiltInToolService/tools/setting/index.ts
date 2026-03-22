// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ToolApprovalRequest } from '@services/AiService/types';
import { native } from '@services/NativeService';

import type { GeneralSettingsData } from '@/stores/settings';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    SETTING_TOOL_DESCRIPTION,
    SETTING_TOOL_INPUT_SCHEMA,
    type SupportedSettingKey,
    type SupportedSettingValue,
} from './constants';
import {
    formatShortcutRegistrationError,
    formatSingleUpdate,
    getSettings,
    listSupportedSettings,
    type ParsedSettingRequest,
    parseSettingRequest,
    prepareSettingsStore,
    readCurrentSettingValue,
    type SettingsStore,
} from './helper';

interface AppliedSettingSnapshot {
    key: SupportedSettingKey;
    previousValue: SupportedSettingValue;
}

async function applySettingSideEffect(
    key: SupportedSettingKey,
    value: SupportedSettingValue
): Promise<void> {
    if (key === 'global_shortcut') {
        try {
            await native.shortcut.registerGlobalShortcut(
                value as GeneralSettingsData['globalShortcut']
            );
        } catch (error) {
            throw new Error(
                formatShortcutRegistrationError(
                    value as GeneralSettingsData['globalShortcut'],
                    error
                )
            );
        }
        return;
    }

    if (key === 'start_on_boot') {
        if (value) {
            await native.autostart.enableAutostart();
        } else {
            await native.autostart.disableAutostart();
        }
    }
}

async function persistSettingValue(
    settingsStore: SettingsStore,
    key: SupportedSettingKey,
    value: SupportedSettingValue
): Promise<void> {
    switch (key) {
        case 'global_shortcut':
            await settingsStore.updateGlobalShortcut(
                value as GeneralSettingsData['globalShortcut']
            );
            return;
        case 'start_on_boot':
            await settingsStore.updateStartOnBoot(value as GeneralSettingsData['startOnBoot']);
            return;
        case 'start_minimized':
            await settingsStore.updateStartMinimized(
                value as GeneralSettingsData['startMinimized']
            );
            return;
        case 'mcp_max_iterations':
            await settingsStore.updateMcpMaxIterations(
                value as GeneralSettingsData['mcpMaxIterations']
            );
            return;
        case 'output_scroll_behavior':
            await settingsStore.updateOutputScrollBehavior(
                value as GeneralSettingsData['outputScrollBehavior']
            );
            return;
        default:
            throw new Error(`不支持的设置键：${key}`);
    }
}

async function applySettingUpdate(
    settingsStore: SettingsStore,
    key: SupportedSettingKey,
    value: SupportedSettingValue
): Promise<void> {
    await applySettingSideEffect(key, value);
    await persistSettingValue(settingsStore, key, value);
}

/**
 * 构建设置修改审批卡片。
 * @param args 工具参数。
 * @returns 审批请求；读取类操作或参数非法时返回 `null`。
 */
export function buildSettingApprovalRequest(
    args: Record<string, unknown>
): ToolApprovalRequest | null {
    let request: ParsedSettingRequest;
    try {
        request = parseSettingRequest(args);
    } catch {
        return null;
    }

    if (request.action !== 'set') {
        return null;
    }

    return {
        title: '设置修改确认',
        description: request.reason,
        command: formatSingleUpdate(request.key, request.value),
        riskLabel: '',
        reason: '此操作会修改 TouchAI 的应用设置，并立即影响后续行为。',
        commandLabel: '',
        approveLabel: '批准',
        rejectLabel: '拒绝',
        enterHint: 'Enter',
        escHint: 'Esc',
        keyboardApproveDelayMs: 450,
    };
}

/**
 * 执行设置工具，统一承接设置列表、读取和单项写入。
 * @param args 工具参数。
 * @param config 当前工具配置。
 * @param context 当前执行上下文。
 * @returns 标准化后的工具执行结果。
 */
export async function executeSettingTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    const request = parseSettingRequest(args);
    const settingsStore = await prepareSettingsStore();
    void config;
    void context.signal;

    if (request.action === 'list') {
        return {
            result: await listSupportedSettings(settingsStore),
            isError: false,
            status: 'success',
        };
    }

    if (request.action === 'get') {
        return {
            result: await getSettings(settingsStore, request.keys),
            isError: false,
            status: 'success',
        };
    }

    const appliedSnapshot: AppliedSettingSnapshot = {
        key: request.key,
        previousValue: await readCurrentSettingValue(settingsStore, request.key),
    };

    try {
        await applySettingUpdate(settingsStore, request.key, request.value);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let rollbackSummary = '';
        try {
            // 设置更新可能在抛错前已经触发部分副作用，
            // 因此失败后仍按执行前快照做一次 best-effort 回滚。
            await applySettingUpdate(
                settingsStore,
                appliedSnapshot.key,
                appliedSnapshot.previousValue
            );
            rollbackSummary = '\n已尝试恢复到执行前的设置值。';
        } catch (rollbackError) {
            rollbackSummary = `\n恢复失败: ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`;
        }
        return {
            result: `设置修改失败\n${formatSingleUpdate(request.key, request.value)}\n原因: ${errorMessage}${rollbackSummary}`,
            isError: true,
            status: 'error',
            errorMessage,
        };
    }

    return {
        result: ['设置已更新', formatSingleUpdate(request.key, request.value)].join('\n'),
        isError: false,
        status: 'success',
    };
}

/**
 * Setting 工具。
 */
class SettingTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'setting' as const;
    readonly displayName = 'Setting';
    readonly description = SETTING_TOOL_DESCRIPTION;
    readonly inputSchema = SETTING_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildApprovalRequest(args: Record<string, unknown>) {
        return buildSettingApprovalRequest(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeSettingTool(args, config, context);
    }
}

export const settingTool = new SettingTool();
export const builtInTools: BuiltInToolGroup = [settingTool];
