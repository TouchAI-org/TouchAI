// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../contracts/builtin';
import type { ToolApprovalRequest } from '../../contracts/events';
import type { ToolMessages } from '../../contracts/host';
import {
    SETTING_DEFINITIONS,
    SETTING_TOOL_DESCRIPTION,
    SETTING_TOOL_INPUT_SCHEMA,
    type SupportedSettingKey,
} from './constants';
import type { ToolSettingsCapabilities } from './host';
import { createSettingOperations, type ParsedSettingRequest } from './operations';

export function createSettingTools(input: {
    messages: ToolMessages;
    settings: ToolSettingsCapabilities;
    warn?(message: string, error: unknown): void;
}): BuiltInToolGroup {
    const t = input.messages.t.bind(input.messages);
    const tt = input.messages.tt.bind(input.messages);
    const settingsService: ToolSettingsCapabilities = Object.freeze({
        read: input.settings.read.bind(input.settings),
        mutate: input.settings.mutate.bind(input.settings),
    });
    const { parseSettingRequest, formatSingleUpdate, listSupportedSettings, getSettings } =
        createSettingOperations(input.messages);
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
    function buildSettingApprovalRequest(
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

    async function executeSettingTool(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        const request = parseSettingRequest(args);
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

        let rejectionMessage: string | null = null;
        try {
            if (context.signal?.aborted) return cancelledSettingResult();
            const result = await settingsService.mutate(request.key, request.value);
            if (result.status === 'committed') {
                const warningNote = result.warning ? `\n${tt('注意')}：${result.warning}` : '';
                return {
                    result:
                        [tt('设置已更新'), formatSingleUpdate(request.key, request.value)].join(
                            '\n'
                        ) + warningNote,
                    isError: false,
                    status: 'success',
                };
            }
            if (result.status === 'unknown' || result.status === 'recovery-required') {
                const message = tt('设置结果未确认，请重新查看设置后再重试。');
                return {
                    result: [formatSingleUpdate(request.key, request.value), message].join('\n'),
                    isError: true,
                    status: 'error',
                    sideEffect: 'unknown',
                    errorMessage: message,
                };
            }
            if (
                result.status === 'rejected' &&
                (result.code === 'settings-rejected' || result.code === 'settings-native-failed')
            ) {
                rejectionMessage = result.message;
            }
        } catch (error) {
            input.warn?.('[SettingTool] Failed to update setting', error);
            const message = tt('设置结果未确认，请重新查看设置后再重试。');
            return {
                result: [formatSingleUpdate(request.key, request.value), message].join('\n'),
                isError: true,
                status: 'error',
                sideEffect: 'unknown',
                errorMessage: message,
            };
        }

        const resultLines = [tt('设置修改失败。'), formatSingleUpdate(request.key, request.value)];
        if (rejectionMessage) {
            resultLines.push(`${tt('原因')}: ${rejectionMessage}`);
        }
        return {
            result: resultLines.join('\n'),
            isError: true,
            status: 'error',
            errorMessage: rejectionMessage ?? tt('设置修改失败。'),
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

    return [new SettingTool()];
}
