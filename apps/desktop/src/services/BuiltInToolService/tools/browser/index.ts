import { native } from '@services/NativeService';

import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import { createBrowserApprovalRequest } from './approval';
import {
    type BrowserAutomationToolConfig,
    DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG,
    parseBrowserAutomationToolConfig,
} from './config';
import {
    BROWSER_ACT_OPERATIONS,
    BROWSER_ACT_TOOL_DESCRIPTION,
    BROWSER_ACT_TOOL_ID,
    BROWSER_ACT_TOOL_INPUT_SCHEMA,
    BROWSER_OBSERVE_OPERATIONS,
    BROWSER_OBSERVE_TOOL_DESCRIPTION,
    BROWSER_OBSERVE_TOOL_ID,
    BROWSER_OBSERVE_TOOL_INPUT_SCHEMA,
    BROWSER_SESSION_OPERATIONS,
    BROWSER_SESSION_TOOL_DESCRIPTION,
    BROWSER_SESSION_TOOL_ID,
    BROWSER_SESSION_TOOL_INPUT_SCHEMA,
} from './constants';
import { formatBrowserToolError, formatBrowserToolResult } from './format';
import { browserOperationForSemantic, requireBrowserOperation } from './operation';

export type BrowserToolId =
    | typeof BROWSER_SESSION_TOOL_ID
    | typeof BROWSER_OBSERVE_TOOL_ID
    | typeof BROWSER_ACT_TOOL_ID;

type BrowserToolConfig = BrowserAutomationToolConfig;
type BrowserSessionOperation = (typeof BROWSER_SESSION_OPERATIONS)[number];
type BrowserObserveOperation = (typeof BROWSER_OBSERVE_OPERATIONS)[number];
type BrowserActOperation = (typeof BROWSER_ACT_OPERATIONS)[number];
type NativeBrowserObserveOperation = 'state' | 'snapshot' | 'screenshot';
type NativeBrowserActOperation =
    | 'click'
    | 'type'
    | 'fill'
    | 'fill_form'
    | 'press_key'
    | 'scroll'
    | 'wait';

function isOneOf<T extends readonly string[]>(value: string, candidates: T): value is T[number] {
    return candidates.includes(value as T[number]);
}

function requireKnownOperation<T extends readonly string[]>(
    toolId: BrowserToolId,
    args: Record<string, unknown>,
    candidates: T
): T[number] {
    const operation = requireBrowserOperation(toolId, args);
    if (!isOneOf(operation, candidates)) {
        throw new Error(`Unsupported ${toolId} operation: ${operation}`);
    }

    return operation;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    return typeof value === 'boolean' ? value : undefined;
}

function rejectHiddenObserveFields(args: Record<string, unknown>): void {
    for (const key of ['includeScreenshot', 'includeDom']) {
        if (Object.prototype.hasOwnProperty.call(args, key)) {
            throw new Error(`browser_observe does not accept hidden field ${key}`);
        }
    }
}

function stringValueArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
}

function optionalConfigString(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function normalizedFormFieldsArg(
    args: Record<string, unknown>,
    key: string
): Array<Record<string, unknown>> | undefined {
    const value = args[key];
    if (!Array.isArray(value)) {
        return undefined;
    }

    const normalized = value
        .filter(
            (field): field is Record<string, unknown> =>
                Boolean(field) && typeof field === 'object' && !Array.isArray(field)
        )
        .map((field) => {
            const refId = stringArg(field, 'refId') ?? stringArg(field, 'ref');
            const navigationToken = stringArg(field, 'navigationToken');
            const value = stringValueArg(field, 'value');
            if (!refId || !navigationToken || value === undefined) {
                return null;
            }

            return { refId, navigationToken, value };
        })
        .filter((field): field is { refId: string; navigationToken: string; value: string } =>
            Boolean(field)
        );

    return normalized.length > 0 ? normalized : undefined;
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, unknown] => entry[1] !== undefined)
    ) as T;
}

function success(operation: string, response: unknown): BuiltInToolExecutionResult {
    const formatted = formatBrowserToolResult(operation, response);
    return {
        result: formatted.result,
        attachments: formatted.attachments,
        isError: false,
        status: 'success',
    };
}

function errorResult(error: unknown): BuiltInToolExecutionResult {
    const message = formatBrowserToolError(error);
    return {
        result: `Browser tool failed: ${message}`,
        isError: true,
        status: 'error',
        errorMessage: message,
    };
}

function semantic(action: BuiltInToolConversationSemantic['action'], target: string) {
    return { action, target };
}

function nativeObserveOperation(operation: BrowserObserveOperation): NativeBrowserObserveOperation {
    switch (operation) {
        case 'current':
        case 'tabs':
            return 'state';
        case 'dom':
            return 'snapshot';
        case 'screenshot':
            return 'screenshot';
    }
}

function isNativeActOperation(
    operation: BrowserActOperation
): operation is NativeBrowserActOperation {
    return (
        operation === 'click' ||
        operation === 'type' ||
        operation === 'fill' ||
        operation === 'fill_form' ||
        operation === 'press_key' ||
        operation === 'scroll' ||
        operation === 'wait'
    );
}

export async function executeBrowserSessionTool(
    args: Record<string, unknown>,
    config: BrowserToolConfig,
    _context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void _context;

    try {
        const operation: BrowserSessionOperation = requireKnownOperation(
            'browser_session',
            args,
            BROWSER_SESSION_OPERATIONS
        );

        switch (operation) {
            case 'status':
                return success(operation, await native.browser.status());
            case 'start':
                return success(
                    operation,
                    await native.browser.start({
                        browserId:
                            stringArg(args, 'browserId') ??
                            (config.mode === 'custom'
                                ? optionalConfigString(config.browserId)
                                : undefined),
                        startupUrl:
                            stringArg(args, 'startupUrl') ??
                            stringArg(args, 'url') ??
                            optionalConfigString(config.startupUrl),
                    })
                );
            case 'stop':
                return success(operation, await native.browser.stop());
            default:
                throw new Error(`Unsupported browser_session operation: ${operation}`);
        }
    } catch (error) {
        return errorResult(error);
    }
}

export async function executeBrowserObserveTool(
    args: Record<string, unknown>,
    _config: BrowserToolConfig,
    _context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void _config;
    void _context;

    try {
        const operation: BrowserObserveOperation = requireKnownOperation(
            'browser_observe',
            args,
            BROWSER_OBSERVE_OPERATIONS
        );

        rejectHiddenObserveFields(args);

        return success(
            operation,
            await native.browser.observe({
                ...compactRecord({
                    operation: nativeObserveOperation(operation),
                    tabId: stringArg(args, 'tabId'),
                    includeConsole: booleanArg(args, 'includeConsole'),
                    includeNetwork: booleanArg(args, 'includeNetwork'),
                }),
            })
        );
    } catch (error) {
        return errorResult(error);
    }
}

export async function executeBrowserActTool(
    args: Record<string, unknown>,
    _config: BrowserToolConfig,
    _context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void _config;
    void _context;

    try {
        const operation: BrowserActOperation = requireKnownOperation(
            'browser_act',
            args,
            BROWSER_ACT_OPERATIONS
        );

        if (operation === 'navigate') {
            return success(
                operation,
                await native.browser.navigate({
                    ...compactRecord({
                        url: String(args.url ?? ''),
                        tabId: stringArg(args, 'tabId'),
                    }),
                })
            );
        }

        if (operation === 'back') {
            return success(
                operation,
                await native.browser.back({ tabId: stringArg(args, 'tabId') })
            );
        }

        if (operation === 'forward') {
            return success(
                operation,
                await native.browser.forward({ tabId: stringArg(args, 'tabId') })
            );
        }

        if (operation === 'reload') {
            return success(
                operation,
                await native.browser.reload({ tabId: stringArg(args, 'tabId') })
            );
        }

        if (!isNativeActOperation(operation)) {
            throw new Error(`Unsupported browser_act operation: ${operation}`);
        }

        return success(
            operation,
            await native.browser.act({
                ...compactRecord({
                    action: operation,
                    tabId: stringArg(args, 'tabId'),
                    ref: stringArg(args, 'ref'),
                    refId: stringArg(args, 'refId'),
                    targetRef: stringArg(args, 'targetRef'),
                    navigationToken: stringArg(args, 'navigationToken'),
                    text: stringValueArg(args, 'text'),
                    value: stringValueArg(args, 'value'),
                    fields: normalizedFormFieldsArg(args, 'fields'),
                    key: stringArg(args, 'key'),
                    deltaX: numberArg(args, 'deltaX'),
                    deltaY: numberArg(args, 'deltaY'),
                    timeoutMs: numberArg(args, 'timeoutMs'),
                }),
            })
        );
    } catch (error) {
        return errorResult(error);
    }
}

abstract class BrowserTool extends BuiltInTool<BrowserToolConfig> {
    readonly defaultConfig: BrowserToolConfig = DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG;

    override parseConfig(configJson: string | null): BrowserToolConfig {
        return parseBrowserAutomationToolConfig(configJson);
    }

    override buildApprovalRequest(
        args: Record<string, unknown>
    ): Promise<ToolApprovalRequest | null> {
        return createBrowserApprovalRequest(this.id as BrowserToolId, args);
    }
}

class BrowserSessionTool extends BrowserTool {
    readonly id = BROWSER_SESSION_TOOL_ID;
    readonly displayName = 'BrowserSession';
    readonly description = BROWSER_SESSION_TOOL_DESCRIPTION;
    readonly inputSchema = BROWSER_SESSION_TOOL_INPUT_SCHEMA;

    override buildConversationSemantic(args: Record<string, unknown>) {
        return semantic('process', `browser ${browserOperationForSemantic(args, 'status')}`);
    }

    override execute(
        args: Record<string, unknown>,
        config: BrowserToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeBrowserSessionTool(args, config, context);
    }
}

class BrowserObserveTool extends BrowserTool {
    readonly id = BROWSER_OBSERVE_TOOL_ID;
    readonly displayName = 'BrowserObserve';
    readonly description = BROWSER_OBSERVE_TOOL_DESCRIPTION;
    readonly inputSchema = BROWSER_OBSERVE_TOOL_INPUT_SCHEMA;

    override buildConversationSemantic(args: Record<string, unknown>) {
        return semantic('read', `browser ${browserOperationForSemantic(args, 'current')}`);
    }

    override execute(
        args: Record<string, unknown>,
        config: BrowserToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeBrowserObserveTool(args, config, context);
    }
}

class BrowserActTool extends BrowserTool {
    readonly id = BROWSER_ACT_TOOL_ID;
    readonly displayName = 'BrowserAct';
    readonly description = BROWSER_ACT_TOOL_DESCRIPTION;
    readonly inputSchema = BROWSER_ACT_TOOL_INPUT_SCHEMA;

    override buildConversationSemantic(args: Record<string, unknown>) {
        return semantic('process', `browser ${browserOperationForSemantic(args, 'act')}`);
    }

    override execute(
        args: Record<string, unknown>,
        config: BrowserToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeBrowserActTool(args, config, context);
    }
}

export const browserSessionTool = new BrowserSessionTool();
export const browserObserveTool = new BrowserObserveTool();
export const browserActTool = new BrowserActTool();
export const builtInTools: BuiltInToolGroup = [
    browserSessionTool,
    browserObserveTool,
    browserActTool,
];

export { createBrowserApprovalRequest } from './approval';
export { formatBrowserToolResult } from './format';
export { redactBrowserValue } from './redaction';
