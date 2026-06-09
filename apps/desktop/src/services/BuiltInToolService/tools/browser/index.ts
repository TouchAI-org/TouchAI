import { getSettingValue } from '@database/queries';
import { native } from '@services/NativeService';

import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';
import type { BrowserExistingSession, BrowserStartRequest } from '@/services/NativeService/types';
import {
    BROWSER_SETTINGS_KEY,
    type BrowserSettingsConfig,
    parseBrowserSettingsConfig,
} from '@/stores/setting/sections/browser';
import {
    type BrowserToolOperation,
    evaluateBrowserPermission,
} from '@/stores/setting/sections/browserPolicy';

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
    BROWSER_OPERATIONS,
    BROWSER_SESSION_OPERATIONS,
    BROWSER_SESSION_TOOL_DESCRIPTION,
    BROWSER_SESSION_TOOL_ID,
    BROWSER_SESSION_TOOL_INPUT_SCHEMA,
    BROWSER_TOOL_DESCRIPTION,
    BROWSER_TOOL_ID,
    BROWSER_TOOL_INPUT_SCHEMA,
} from './constants';
import { formatBrowserToolError, formatBrowserToolResult } from './format';
import { requireBrowserOperation, resolveBrowserOperationDescription } from './operation';

export type BrowserToolId =
    | typeof BROWSER_TOOL_ID
    | typeof BROWSER_SESSION_TOOL_ID
    | typeof BROWSER_OBSERVE_TOOL_ID
    | typeof BROWSER_ACT_TOOL_ID;

type BrowserToolConfig = BrowserAutomationToolConfig;
type BrowserSessionOperation = (typeof BROWSER_SESSION_OPERATIONS)[number];
type BrowserObserveOperation = (typeof BROWSER_OBSERVE_OPERATIONS)[number];
type BrowserActOperation = (typeof BROWSER_ACT_OPERATIONS)[number];
type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];
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

function omitUndefinedBrowserStartRequest(request: BrowserStartRequest): BrowserStartRequest {
    return Object.fromEntries(
        Object.entries(request).filter(([, value]) => value !== undefined)
    ) as BrowserStartRequest;
}

async function loadBrowserSettings(): Promise<BrowserSettingsConfig> {
    return parseBrowserSettingsConfig(await getSettingValue({ key: BROWSER_SETTINGS_KEY }));
}

async function ensureBrowserPermission(
    config: BrowserSettingsConfig,
    operation: BrowserToolOperation,
    metadata: { url?: string | null; availableSessionCount?: number | null } = {},
    context?: BaseBuiltInToolExecutionContext,
    description?: string
): Promise<void> {
    const decision = evaluateBrowserPermission(config, operation, metadata);
    if (decision.decision === 'deny') {
        throw new Error(`Browser permission denied: ${decision.reason}`);
    }
    if (decision.decision === 'ask') {
        await requestBrowserPermission(context, description ?? operation, decision.reason);
    }
}

async function requestBrowserPermission(
    context: BaseBuiltInToolExecutionContext | undefined,
    description: string,
    reason: string
): Promise<void> {
    if (!context?.requestUserQuestions) {
        throw new Error(`Browser permission requires user confirmation: ${reason}`);
    }

    const answers = await context.requestUserQuestions(context.callId, [
        {
            header: '浏览器权限',
            question: `是否允许浏览器操作：${description}`,
            options: [
                { label: '允许本次', description: '继续执行这一次浏览器操作。' },
                { label: '拒绝', description: '停止这一次浏览器操作。' },
            ],
        },
    ]);
    const selected = answers?.[0];
    if (!selected || selected.skipped || !selected.selectedLabels.includes('允许本次')) {
        throw new Error('Browser permission was not approved by the user');
    }
}

function sessionOptionLabel(session: BrowserExistingSession, index: number): string {
    return `${index + 1}. ${session.label || session.endpoint}`;
}

async function chooseExistingSession(
    sessions: BrowserExistingSession[],
    context: BaseBuiltInToolExecutionContext,
    description: string
): Promise<BrowserExistingSession> {
    if (!context.requestUserQuestions) {
        throw new Error('Connecting an existing browser session requires user confirmation');
    }

    const options = sessions.map((session, index) => ({
        label: sessionOptionLabel(session, index),
        description: session.currentUrl || session.title || session.endpoint,
    }));
    options.push({ label: '取消', description: '不连接任何已有浏览器会话。' });

    const answers = await context.requestUserQuestions(context.callId, [
        {
            header: '选择浏览器',
            question: `${description}。请选择要连接的已有浏览器会话。`,
            options,
        },
    ]);
    const selectedLabel = answers?.[0]?.selectedLabels[0];
    if (!selectedLabel || selectedLabel === '取消') {
        throw new Error('Existing browser session connection was cancelled by the user');
    }

    const selectedIndex = options.findIndex((option) => option.label === selectedLabel);
    if (selectedIndex < 0 || selectedIndex >= sessions.length) {
        throw new Error('Selected browser session was not found');
    }
    return sessions[selectedIndex] as BrowserExistingSession;
}

async function resolveExistingSession(
    settings: BrowserSettingsConfig,
    context: BaseBuiltInToolExecutionContext,
    description: string
): Promise<BrowserExistingSession> {
    if (settings.existingSessionPolicy === 'deny') {
        throw new Error('Browser permission denied: existing-browser-session-policy-deny');
    }

    const sessions = await native.browser.discoverExisting();
    if (sessions.length === 0) {
        throw new Error(
            'No connectable existing browser session was found. Start a managed browser session, or open Chrome/Edge with a loopback remote debugging port if an existing session is required.'
        );
    }

    const decision = evaluateBrowserPermission(settings, 'connect_existing', {
        availableSessionCount: sessions.length,
    });
    if (decision.decision === 'deny') {
        throw new Error(`Browser permission denied: ${decision.reason}`);
    }
    if (decision.decision === 'allow' && settings.existingSessionPolicy === 'auto') {
        return sessions[0] as BrowserExistingSession;
    }

    return chooseExistingSession(sessions, context, description);
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

function browserSemantic(
    args: Record<string, unknown>,
    fallbackOperation: BrowserSessionOperation | BrowserObserveOperation | BrowserActOperation
) {
    try {
        return semantic('cursor', resolveBrowserOperationDescription(args, fallbackOperation));
    } catch {
        return semantic('cursor', '需要操作说明');
    }
}

function ensureBrowserDescription(
    args: Record<string, unknown>,
    fallbackOperation: BrowserSessionOperation | BrowserObserveOperation | BrowserActOperation
): void {
    resolveBrowserOperationDescription(args, fallbackOperation);
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

function observePermissionOperation(operation: BrowserObserveOperation): BrowserToolOperation {
    return operation === 'screenshot' ? 'screenshot' : operation;
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

function isBrowserSessionOperation(
    operation: BrowserOperation
): operation is BrowserSessionOperation {
    return isOneOf(operation, BROWSER_SESSION_OPERATIONS);
}

function isBrowserObserveOperation(
    operation: BrowserOperation
): operation is BrowserObserveOperation {
    return isOneOf(operation, BROWSER_OBSERVE_OPERATIONS);
}

function isBrowserActOperation(operation: BrowserOperation): operation is BrowserActOperation {
    return isOneOf(operation, BROWSER_ACT_OPERATIONS);
}

export async function executeBrowserTool(
    args: Record<string, unknown>,
    config: BrowserToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    const operation = requireKnownOperation('browser', args, BROWSER_OPERATIONS);

    if (isBrowserSessionOperation(operation)) {
        return executeBrowserSessionTool(args, config, context);
    }

    if (isBrowserObserveOperation(operation)) {
        return executeBrowserObserveTool(args, config, context);
    }

    if (isBrowserActOperation(operation)) {
        return executeBrowserActTool(args, config, context);
    }

    return errorResult(`Unsupported browser operation: ${operation}`);
}

export async function executeBrowserSessionTool(
    args: Record<string, unknown>,
    config: BrowserToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    try {
        const operation: BrowserSessionOperation = requireKnownOperation(
            'browser_session',
            args,
            BROWSER_SESSION_OPERATIONS
        );
        ensureBrowserDescription(args, operation);
        const description = resolveBrowserOperationDescription(args, operation);
        const browserSettings = await loadBrowserSettings();

        switch (operation) {
            case 'status':
                await ensureBrowserPermission(browserSettings, operation, {}, context, description);
                return success(operation, await native.browser.status());
            case 'start':
                await ensureBrowserPermission(browserSettings, operation, {}, context, description);
                return success(
                    operation,
                    await native.browser.start(
                        omitUndefinedBrowserStartRequest({
                            headless: browserSettings.headless ? true : undefined,
                            startupUrl:
                                stringArg(args, 'startupUrl') ??
                                stringArg(args, 'url') ??
                                optionalConfigString(browserSettings.defaultHomepage) ??
                                optionalConfigString(config.startupUrl),
                            browserExecutablePath: optionalConfigString(
                                browserSettings.browserExecutablePath
                            ),
                            browserDataPath: optionalConfigString(browserSettings.browserDataPath),
                            fingerprintMode: browserSettings.fingerprintMode,
                            fingerprintLocale: optionalConfigString(
                                browserSettings.fingerprintLocale
                            ),
                            fingerprintTimezone: optionalConfigString(
                                browserSettings.fingerprintTimezone
                            ),
                            fingerprintUserAgent: optionalConfigString(
                                browserSettings.fingerprintUserAgent
                            ),
                            fingerprintWindowSize: optionalConfigString(
                                browserSettings.fingerprintWindowSize
                            ),
                            fingerprintStealthScript: browserSettings.fingerprintStealthScript,
                        })
                    )
                );
            case 'stop':
                await ensureBrowserPermission(browserSettings, operation, {}, context, description);
                return success(operation, await native.browser.stop());
            case 'connect_existing':
                return success(
                    operation,
                    await native.browser.connectExisting({
                        endpoint: (
                            await resolveExistingSession(browserSettings, context, description)
                        ).endpoint,
                    })
                );
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
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void _config;

    try {
        const operation: BrowserObserveOperation = requireKnownOperation(
            'browser_observe',
            args,
            BROWSER_OBSERVE_OPERATIONS
        );
        ensureBrowserDescription(args, operation);
        rejectHiddenObserveFields(args);
        const description = resolveBrowserOperationDescription(args, operation);
        const browserSettings = await loadBrowserSettings();
        await ensureBrowserPermission(
            browserSettings,
            observePermissionOperation(operation),
            {},
            context,
            description
        );

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
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void _config;

    try {
        const operation: BrowserActOperation = requireKnownOperation(
            'browser_act',
            args,
            BROWSER_ACT_OPERATIONS
        );
        ensureBrowserDescription(args, operation);
        const description = resolveBrowserOperationDescription(args, operation);
        const browserSettings = await loadBrowserSettings();

        if (operation === 'navigate') {
            const url = String(args.url ?? '');
            await ensureBrowserPermission(
                browserSettings,
                operation,
                { url },
                context,
                description
            );
            return success(
                operation,
                await native.browser.navigate({
                    ...compactRecord({
                        url,
                        tabId: stringArg(args, 'tabId'),
                    }),
                })
            );
        }

        await ensureBrowserPermission(browserSettings, operation, {}, context, description);

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
        return browserSemantic(args, 'status');
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
        return browserSemantic(args, 'current');
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
        return browserSemantic(args, 'click');
    }

    override execute(
        args: Record<string, unknown>,
        config: BrowserToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeBrowserActTool(args, config, context);
    }
}

class BrowserUnifiedTool extends BrowserTool {
    readonly id = BROWSER_TOOL_ID;
    readonly displayName = 'Browser';
    readonly description = BROWSER_TOOL_DESCRIPTION;
    readonly inputSchema = BROWSER_TOOL_INPUT_SCHEMA;

    override buildConversationSemantic(args: Record<string, unknown>) {
        return browserSemantic(args, 'current');
    }

    override execute(
        args: Record<string, unknown>,
        config: BrowserToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeBrowserTool(args, config, context);
    }
}

export const browserSessionTool = new BrowserSessionTool();
export const browserObserveTool = new BrowserObserveTool();
export const browserActTool = new BrowserActTool();
export const browserTool = new BrowserUnifiedTool();
export const builtInTools: BuiltInToolGroup = [browserTool];

export { createBrowserApprovalRequest } from './approval';
export { formatBrowserToolResult } from './format';
export { redactBrowserValue } from './redaction';
