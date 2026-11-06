// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { t, tt } from '@/i18n';
import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';
import { truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    SETTING_DEFINITIONS,
    SETTING_TOOL_DESCRIPTION,
    SETTING_TOOL_INPUT_SCHEMA,
    type SupportedSettingKey,
} from './constants';
import {
    formatSingleUpdate,
    getSettings,
    listSupportedSettings,
    type ParsedSettingRequest,
    parseSettingRequest,
    prepareSettingsService,
} from './helper';

function joinSettingLabels(keys: SupportedSettingKey[]): string {
    if (keys.length === 0) {
        return tt('应用设置');
    }

    return truncateText(keys.map((key) => tt(SETTING_DEFINITIONS[key].label)).join(', '), 80);
}

function buildSettingConversationSemantic(
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    try {
        const request = parseSettingRequest(args);
        return {
            action: request.action === 'set' ? 'update' : 'read',
            target:
                request.action === 'list'
                    ? tt('可用设置')
                    : request.action === 'get'
                      ? joinSettingLabels(request.keys)
                      : tt(SETTING_DEFINITIONS[request.key].label),
        };
    } catch {
        return {
            action: 'process',
            target: tt('应用设置'),
        };
    }
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
        title: tt('设置修改确认'),
        description: request.reason,
        command: formatSingleUpdate(request.key, request.value),
        riskLabel: '',
        reason: tt('此操作会修改 TouchAI 的应用设置，并立即影响后续行为。'),
        commandLabel: '',
        approveLabel: tt('批准'),
        rejectLabel: tt('拒绝'),
        enterHint: 'Enter',
        escHint: 'Esc',
        keyboardApproveDelayMs: 450,
    };
}

/**
 * 执行设置工具，统一承接设置列表、读取和单项写入。写入走 SettingsService 单一所有者，
 * 由所有者串行执行原生副作用与持久化，并区分 committed / rejected / restored /
 * recovery-required / unknown 结果。
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
    if (context.signal?.aborted) return cancelledSettingResult();

    const settingsService = await prepareSettingsService();
    // Owner initialization can take a turn. Re-check before dispatching a read or
    // write so a user cancellation cannot slip through that await. Once `mutate`
    // starts, its committed/unknown result is authoritative and is never guessed
    // or blindly rolled back here.
    if (context.signal?.aborted) return cancelledSettingResult();
    void config;

    if (request.action === 'list') {
        return {
            result: await listSupportedSettings(settingsService),
            isError: false,
            status: 'success',
        };
    }

    if (request.action === 'get') {
        return {
            result: await getSettings(settingsService, request.keys),
            isError: false,
            status: 'success',
        };
    }

    let errorMessage: string;
    try {
        if (context.signal?.aborted) return cancelledSettingResult();
        const result = await settingsService.mutate(request.key, request.value);
        if (result.status === 'committed') {
            const warningNote = result.warning ? `\n${tt('注意')}：${result.warning}` : '';
            return {
                result:
                    [tt('设置已更新'), formatSingleUpdate(request.key, request.value)].join('\n') +
                    warningNote,
                isError: false,
                status: 'success',
            };
        }
        errorMessage = result.message;
    } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
    }

    return {
        result: `${tt('设置修改失败')}\n${formatSingleUpdate(request.key, request.value)}\n${tt('原因')}: ${errorMessage}`,
        isError: true,
        status: 'error',
        errorMessage,
    };
}

function cancelledSettingResult(): BuiltInToolExecutionResult {
    const message = t('common.requestCancelled');
    return {
        result: message,
        isError: true,
        status: 'error',
        errorMessage: message,
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

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildSettingConversationSemantic(args);
    }

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
