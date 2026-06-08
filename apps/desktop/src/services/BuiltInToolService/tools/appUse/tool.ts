// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import { t } from '@/i18n';
import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import { parseToolArguments } from '../../utils/toolSchema';
import {
    type AppUseToolConfig,
    DEFAULT_APP_USE_TOOL_CONFIG,
    parseAppUseToolConfig,
} from './config';
import {
    APP_ACT_TOOL_DESCRIPTION,
    APP_ACT_TOOL_ID,
    APP_ACT_TOOL_INPUT_SCHEMA,
    APP_OBSERVE_TOOL_DESCRIPTION,
    APP_OBSERVE_TOOL_ID,
    APP_OBSERVE_TOOL_INPUT_SCHEMA,
    APP_SESSION_TOOL_DESCRIPTION,
    APP_SESSION_TOOL_ID,
    APP_SESSION_TOOL_INPUT_SCHEMA,
    appUseActArgsSchema,
    appUseObserveArgsSchema,
    appUseSessionArgsSchema,
} from './constants';

function success(result: unknown): BuiltInToolExecutionResult {
    return {
        result: JSON.stringify(result, null, 2),
        isError: false,
        status: 'success',
    };
}

function appUseSemantic(target: string): BuiltInToolConversationSemantic {
    return {
        action: 'process',
        target,
    };
}

function truncatePreview(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized;
}

function buildParameterPreview(parameters: Record<string, unknown>): string {
    if (typeof parameters.text === 'string') {
        return truncatePreview(parameters.text);
    }

    return truncatePreview(JSON.stringify(parameters));
}

function buildActionApprovalDescription(parsed: {
    description: string;
    targetId?: string;
    parameters: Record<string, unknown>;
}): string {
    const lines = [parsed.description];
    if (parsed.targetId) {
        lines.push(`${t('builtInTools.appUse.approval.targetLabel')}: ${parsed.targetId}`);
    }

    const preview = buildParameterPreview(parsed.parameters);
    lines.push(`${t('builtInTools.appUse.approval.previewLabel')}: ${preview}`);

    return lines.join('\n');
}

export async function executeAppSessionTool(
    args: Record<string, unknown>,
    config: AppUseToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    const parsed = parseToolArguments('AppSession', appUseSessionArgsSchema, args);
    return success(
        await native.appUse.session({
            executionId: context.callId,
            operation: parsed.operation,
            description: parsed.description,
            adapterId: parsed.adapterId,
            targetKind: parsed.targetKind,
            config,
        })
    );
}

export async function executeAppObserveTool(
    args: Record<string, unknown>,
    config: AppUseToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    const parsed = parseToolArguments('AppObserve', appUseObserveArgsSchema, args);
    return success(
        await native.appUse.observe({
            executionId: context.callId,
            adapterId: parsed.adapterId,
            scope: parsed.scope,
            description: parsed.description,
            targetId: parsed.targetId,
            maxOutputChars: parsed.maxOutputChars ?? config.maxOutputChars,
            config,
        })
    );
}

export async function executeAppActTool(
    args: Record<string, unknown>,
    config: AppUseToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    const parsed = parseToolArguments('AppAct', appUseActArgsSchema, args);
    if (config.mode === 'read_only') {
        return {
            result: 'App Use is currently in read-only mode. Enable interactive mode before running app actions.',
            isError: true,
            status: 'error',
            errorMessage: 'App Use is in read-only mode',
        };
    }

    const authorization = await native.appUse.authorizeAct({
        executionId: context.callId,
        adapterId: parsed.adapterId,
        action: parsed.action,
        targetId: parsed.targetId,
        parameters: parsed.parameters,
        config,
    });
    if (!authorization.permit) {
        return {
            result: 'App Use native authorization failed. Re-run the action after user approval.',
            isError: true,
            status: 'error',
            errorMessage: 'App Use native authorization failed',
        };
    }

    return success(
        await native.appUse.act({
            executionId: context.callId,
            adapterId: parsed.adapterId,
            action: parsed.action,
            description: parsed.description,
            targetId: parsed.targetId,
            parameters: parsed.parameters,
            permit: authorization.permit,
            config,
        })
    );
}

abstract class AppUseTool extends BuiltInTool<AppUseToolConfig> {
    readonly defaultConfig = DEFAULT_APP_USE_TOOL_CONFIG;

    override parseConfig(configJson: string | null): AppUseToolConfig {
        return parseAppUseToolConfig(configJson);
    }
}

class AppSessionTool extends AppUseTool {
    readonly id = APP_SESSION_TOOL_ID;
    readonly displayName = 'AppSession';
    readonly description = APP_SESSION_TOOL_DESCRIPTION;
    readonly inputSchema = APP_SESSION_TOOL_INPUT_SCHEMA;

    override buildConversationSemantic() {
        return appUseSemantic('App Use session');
    }

    override execute(
        args: Record<string, unknown>,
        config: AppUseToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeAppSessionTool(args, config, context);
    }
}

class AppObserveTool extends AppUseTool {
    readonly id = APP_OBSERVE_TOOL_ID;
    readonly displayName = 'AppObserve';
    readonly description = APP_OBSERVE_TOOL_DESCRIPTION;
    readonly inputSchema = APP_OBSERVE_TOOL_INPUT_SCHEMA;

    override buildConversationSemantic() {
        return appUseSemantic('App Use observation');
    }

    override execute(
        args: Record<string, unknown>,
        config: AppUseToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeAppObserveTool(args, config, context);
    }
}

class AppActTool extends AppUseTool {
    readonly id = APP_ACT_TOOL_ID;
    readonly displayName = 'AppAct';
    readonly description = APP_ACT_TOOL_DESCRIPTION;
    readonly inputSchema = APP_ACT_TOOL_INPUT_SCHEMA;

    override buildApprovalRequest(args: Record<string, unknown>): ToolApprovalRequest | null {
        const parsed = parseToolArguments('AppAct', appUseActArgsSchema, args);
        const command = parsed.targetId
            ? `${parsed.adapterId}:${parsed.action} -> ${parsed.targetId}`
            : `${parsed.adapterId}:${parsed.action}`;
        return {
            title: t('builtInTools.appUse.approval.title'),
            description: buildActionApprovalDescription(parsed),
            command,
            riskLabel: t('builtInTools.appUse.approval.riskLabel'),
            reason: t('builtInTools.appUse.approval.reason'),
            commandLabel: t('builtInTools.appUse.approval.commandLabel'),
            approveLabel: t('builtInTools.appUse.approval.approveLabel'),
            rejectLabel: t('builtInTools.appUse.approval.rejectLabel'),
            enterHint: 'Enter',
            escHint: 'Esc',
            keyboardApproveDelayMs: 450,
        };
    }

    override buildConversationSemantic() {
        return appUseSemantic('App Use action');
    }

    override execute(
        args: Record<string, unknown>,
        config: AppUseToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeAppActTool(args, config, context);
    }
}

export const appSessionTool = new AppSessionTool();
export const appObserveTool = new AppObserveTool();
export const appActTool = new AppActTool();
export const builtInTools: BuiltInToolGroup = [appSessionTool, appObserveTool, appActTool];
