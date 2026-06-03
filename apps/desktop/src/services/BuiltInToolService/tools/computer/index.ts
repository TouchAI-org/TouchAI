// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    COMPUTER_ACT_TOOL_DESCRIPTION,
    COMPUTER_ACT_TOOL_INPUT_SCHEMA,
    COMPUTER_OBSERVE_TOOL_DESCRIPTION,
    COMPUTER_OBSERVE_TOOL_INPUT_SCHEMA,
    COMPUTER_SESSION_TOOL_DESCRIPTION,
    COMPUTER_SESSION_TOOL_INPUT_SCHEMA,
    type ComputerToolConfig,
    DEFAULT_COMPUTER_TOOL_CONFIG,
} from './constants';
import {
    buildComputerActionRequest,
    buildComputerObservationRequest,
    buildComputerSessionRequest,
    computerActionReceipt,
    formatComputerActionResult,
    formatComputerObservationResult,
    formatComputerSessionResult,
    parseComputerToolConfig,
} from './helper';

function errorResult(error: unknown): BuiltInToolExecutionResult {
    if (error instanceof AiError && error.code === AiErrorCode.REQUEST_CANCELLED) {
        throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
        result: errorMessage,
        isError: true,
        status: 'error',
        errorMessage,
    };
}

function throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
    }
}

function buildComputerSemantic(
    action: BuiltInToolConversationSemantic['action'],
    fallbackTarget: string,
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    const reason = normalizeOptionalString(args.reason, { collapseWhitespace: true });
    return {
        action,
        target: truncateText(reason || fallbackTarget, 120),
    };
}

export async function executeComputerSessionTool(
    args: Record<string, unknown>,
    config: ComputerToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    try {
        throwIfCancelled(context.signal);
        const request = buildComputerSessionRequest(args, config, context.callId);
        const response = await native.builtInTools.startComputerSession(request);
        throwIfCancelled(context.signal);

        return {
            result: formatComputerSessionResult(response),
            isError: response.status !== 'ready',
            status: response.status === 'ready' ? 'success' : 'error',
            errorMessage:
                response.status === 'ready' ? null : `Computer session ${response.status}`,
        };
    } catch (error) {
        return errorResult(error);
    }
}

export async function executeComputerObserveTool(
    args: Record<string, unknown>,
    config: ComputerToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    try {
        throwIfCancelled(context.signal);
        const request = buildComputerObservationRequest(args, config);
        const response = await native.builtInTools.observeComputer(request);
        throwIfCancelled(context.signal);

        return {
            result: formatComputerObservationResult(response),
            isError: false,
            status: 'success',
        };
    } catch (error) {
        return errorResult(error);
    }
}

export async function executeComputerActTool(
    args: Record<string, unknown>,
    config: ComputerToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    try {
        if (context.hasExecutedBuiltInTool('computer_act')) {
            throw new Error('computer_act can run only once per turn');
        }

        throwIfCancelled(context.signal);
        const request = buildComputerActionRequest(args, config);
        const response = await native.builtInTools.executeComputerAction(request);
        throwIfCancelled(context.signal);
        const receipt = computerActionReceipt(response);

        return {
            result: formatComputerActionResult(response),
            isError: receipt.status !== 'success',
            status: receipt.status === 'success' ? 'success' : 'error',
            errorMessage: receipt.status === 'success' ? null : `Computer action ${receipt.status}`,
        };
    } catch (error) {
        return errorResult(error);
    }
}

class ComputerSessionTool extends BuiltInTool<ComputerToolConfig> {
    readonly id = 'computer_session' as const;
    readonly displayName = 'Computer Session';
    readonly description = COMPUTER_SESSION_TOOL_DESCRIPTION;
    readonly inputSchema = COMPUTER_SESSION_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = DEFAULT_COMPUTER_TOOL_CONFIG;

    override parseConfig(configJson: string | null): ComputerToolConfig {
        return parseComputerToolConfig(configJson);
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildComputerSemantic('process', 'computer session', args);
    }

    override execute(
        args: Record<string, unknown>,
        config: ComputerToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeComputerSessionTool(args, config, context);
    }
}

class ComputerObserveTool extends BuiltInTool<ComputerToolConfig> {
    readonly id = 'computer_observe' as const;
    readonly displayName = 'Computer Observe';
    readonly description = COMPUTER_OBSERVE_TOOL_DESCRIPTION;
    readonly inputSchema = COMPUTER_OBSERVE_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = DEFAULT_COMPUTER_TOOL_CONFIG;

    override parseConfig(configJson: string | null): ComputerToolConfig {
        return parseComputerToolConfig(configJson);
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildComputerSemantic('process', 'computer observation', args);
    }

    override execute(
        args: Record<string, unknown>,
        config: ComputerToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeComputerObserveTool(args, config, context);
    }
}

class ComputerActTool extends BuiltInTool<ComputerToolConfig> {
    readonly id = 'computer_act' as const;
    readonly displayName = 'Computer Act';
    readonly description = COMPUTER_ACT_TOOL_DESCRIPTION;
    readonly inputSchema = COMPUTER_ACT_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = DEFAULT_COMPUTER_TOOL_CONFIG;

    override parseConfig(configJson: string | null): ComputerToolConfig {
        return parseComputerToolConfig(configJson);
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildComputerSemantic('run', 'computer action', args);
    }

    override execute(
        args: Record<string, unknown>,
        config: ComputerToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeComputerActTool(args, config, context);
    }
}

export const computerSessionTool = new ComputerSessionTool();
export const computerObserveTool = new ComputerObserveTool();
export const computerActTool = new ComputerActTool();

export const builtInTools: BuiltInToolGroup = [
    computerSessionTool,
    computerObserveTool,
    computerActTool,
];

export { DEFAULT_COMPUTER_TOOL_CONFIG } from './constants';
export { parseComputerToolConfig } from './helper';
export type { ComputerToolConfig };
