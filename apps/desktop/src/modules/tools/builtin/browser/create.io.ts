import { getSettingValue } from '@database/queries/settings';
import { AiError, AiErrorCode } from '@touchai/models/contracts';

import { native } from '@/platform/native';
import type { BrowserExistingSession, BrowserStartRequest } from '@/platform/native/types';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../contracts/builtin';
import type { ToolApprovalRequest } from '../../contracts/events';
import type { ToolMessages } from '../../contracts/host';
import { createBrowserApprovals } from './approval';
import {
    type BrowserAutomationToolConfig,
    DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG,
    parseBrowserAutomationToolConfig,
} from './config';
import {
    BROWSER_SETTINGS_KEY,
    type BrowserSettingsConfig,
    parseBrowserSettingsConfig,
} from './configuration';
import {
    BROWSER_ACT_OPERATIONS,
    BROWSER_OBSERVE_OPERATIONS,
    BROWSER_OPERATIONS,
    BROWSER_SESSION_OPERATIONS,
    BROWSER_TOOL_DESCRIPTION,
    BROWSER_TOOL_ID,
    BROWSER_TOOL_INPUT_SCHEMA,
} from './constants';
import { formatBrowserToolError, formatBrowserToolResult } from './format';
import { requireBrowserOperation, resolveBrowserOperationDescription } from './operation';
import { type BrowserToolOperation, evaluateBrowserPermission } from './policy';
import type { BrowserToolId } from './types';

export function createBrowserTools(
    input: { messages: ToolMessages },
    captured?: BrowserSettingsConfig
): BuiltInToolGroup {
    const t = input.messages.t.bind(input.messages);
    const { createBrowserApprovalRequest } = createBrowserApprovals(
        input.messages,
        loadBrowserSettings
    );
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

    function isOneOf<T extends readonly string[]>(
        value: string,
        candidates: T
    ): value is T[number] {
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
        if (captured) return structuredClone(captured);
        return loadLiveBrowserSettings();
    }

    async function loadLiveBrowserSettings(): Promise<BrowserSettingsConfig> {
        return parseBrowserSettingsConfig(await getSettingValue({ key: BROWSER_SETTINGS_KEY }));
    }

    function throwIfBrowserCancelled(signal?: AbortSignal): void {
        if (signal?.aborted) {
            throw new AiError(AiErrorCode.REQUEST_CANCELLED);
        }
    }

    function rethrowIfBrowserCancelled(error: unknown): void {
        if (error instanceof AiError && error.is(AiErrorCode.REQUEST_CANCELLED)) {
            throw error;
        }
    }

    async function ensureBrowserPermission(
        config: BrowserSettingsConfig,
        operation: BrowserToolOperation,
        metadata: { url?: string | null; availableSessionCount?: number | null } = {},
        context?: BaseBuiltInToolExecutionContext,
        description?: string
    ): Promise<void> {
        throwIfBrowserCancelled(context?.signal);
        for (const settings of [config, await loadLiveBrowserSettings()]) {
            const decision = evaluateBrowserPermission(settings, operation, metadata);
            if (decision.decision === 'deny')
                throw new Error(`Browser permission denied: ${decision.reason}`);
            if (decision.decision === 'ask' && context?.approvalGranted !== true) {
                const target = description?.trim() || operation;
                throw new Error(
                    `Browser permission requires user confirmation for ${target}: ${decision.reason}`
                );
            }
        }
        throwIfBrowserCancelled(context?.signal);
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
        const cancelLabel = t('builtInTools.browser.existingSession.cancel');
        options.push({
            label: cancelLabel,
            description: t('builtInTools.browser.existingSession.cancel.description'),
        });

        const answers = await context.requestUserQuestions(context.callId, [
            {
                header: t('builtInTools.browser.existingSession.header'),
                question: t('builtInTools.browser.existingSession.question', { description }),
                options,
            },
        ]);
        throwIfBrowserCancelled(context.signal);
        const selectedLabel = answers?.[0]?.selectedLabels[0];
        if (!selectedLabel || selectedLabel === cancelLabel) {
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
    ): Promise<{ session: BrowserExistingSession; confirmed: boolean }> {
        throwIfBrowserCancelled(context.signal);
        const preflight = evaluateBrowserPermission(settings, 'connect_existing');
        if (preflight.decision === 'deny') {
            throw new Error(`Browser permission denied: ${preflight.reason}`);
        }
        if (preflight.decision === 'ask' && !context.requestUserQuestions) {
            throw new Error('Connecting an existing browser session requires user confirmation');
        }

        throwIfBrowserCancelled(context.signal);
        const live = evaluateBrowserPermission(await loadLiveBrowserSettings(), 'connect_existing');
        if (live.decision === 'deny') throw new Error(`Browser permission denied: ${live.reason}`);
        const sessions = await native.browser.discoverExisting();
        throwIfBrowserCancelled(context.signal);
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
            throwIfBrowserCancelled(context.signal);
            return { session: sessions[0] as BrowserExistingSession, confirmed: false };
        }

        const selected = await chooseExistingSession(sessions, context, description);
        throwIfBrowserCancelled(context.signal);
        return { session: selected, confirmed: true };
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
            Object.entries(value).filter(
                (entry): entry is [string, unknown] => entry[1] !== undefined
            )
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

    function nativeObserveOperation(
        operation: BrowserObserveOperation
    ): NativeBrowserObserveOperation {
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

    async function executeBrowserTool(
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

    async function executeBrowserSessionTool(
        args: Record<string, unknown>,
        config: BrowserToolConfig,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        try {
            throwIfBrowserCancelled(context.signal);
            const operation: BrowserSessionOperation = requireKnownOperation(
                'browser_session',
                args,
                BROWSER_SESSION_OPERATIONS
            );
            ensureBrowserDescription(args, operation);
            const description = resolveBrowserOperationDescription(args, operation);
            const browserSettings = await loadBrowserSettings();
            throwIfBrowserCancelled(context.signal);

            switch (operation) {
                case 'status':
                    await ensureBrowserPermission(
                        browserSettings,
                        operation,
                        {},
                        context,
                        description
                    );
                    return success(operation, await native.browser.status());
                case 'start':
                    await ensureBrowserPermission(
                        browserSettings,
                        operation,
                        {},
                        context,
                        description
                    );
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
                                browserDataPath: optionalConfigString(
                                    browserSettings.browserDataPath
                                ),
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
                    await ensureBrowserPermission(
                        browserSettings,
                        operation,
                        {},
                        context,
                        description
                    );
                    return success(operation, await native.browser.stop());
                case 'connect_existing': {
                    const selected = await resolveExistingSession(
                        browserSettings,
                        context,
                        description
                    );
                    await ensureBrowserPermission(
                        browserSettings,
                        operation,
                        {},
                        { ...context, approvalGranted: selected.confirmed },
                        description
                    );
                    const session = selected.session;
                    throwIfBrowserCancelled(context.signal);
                    return success(
                        operation,
                        await native.browser.connectExisting({
                            endpoint: session.endpoint,
                        })
                    );
                }
                default:
                    throw new Error(`Unsupported browser_session operation: ${operation}`);
            }
        } catch (error) {
            rethrowIfBrowserCancelled(error);
            return errorResult(error);
        }
    }

    async function executeBrowserObserveTool(
        args: Record<string, unknown>,
        _config: BrowserToolConfig,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        void _config;

        try {
            throwIfBrowserCancelled(context.signal);
            const operation: BrowserObserveOperation = requireKnownOperation(
                'browser_observe',
                args,
                BROWSER_OBSERVE_OPERATIONS
            );
            ensureBrowserDescription(args, operation);
            rejectHiddenObserveFields(args);
            const description = resolveBrowserOperationDescription(args, operation);
            const browserSettings = await loadBrowserSettings();
            throwIfBrowserCancelled(context.signal);
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
            rethrowIfBrowserCancelled(error);
            return errorResult(error);
        }
    }

    async function executeBrowserActTool(
        args: Record<string, unknown>,
        _config: BrowserToolConfig,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        void _config;

        try {
            throwIfBrowserCancelled(context.signal);
            const operation: BrowserActOperation = requireKnownOperation(
                'browser_act',
                args,
                BROWSER_ACT_OPERATIONS
            );
            ensureBrowserDescription(args, operation);
            const description = resolveBrowserOperationDescription(args, operation);
            const browserSettings = await loadBrowserSettings();
            throwIfBrowserCancelled(context.signal);

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
            rethrowIfBrowserCancelled(error);
            return errorResult(error);
        }
    }

    abstract class BrowserTool extends BuiltInTool<BrowserToolConfig> {
        readonly defaultConfig: BrowserToolConfig = DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG;
        override async prepareForTurn() {
            if (captured) return this;
            return createBrowserTools(
                input,
                await loadLiveBrowserSettings()
            )[0]! as BrowserUnifiedTool;
        }

        override parseConfig(configJson: string | null): BrowserToolConfig {
            return parseBrowserAutomationToolConfig(configJson);
        }

        override buildApprovalRequest(
            args: Record<string, unknown>
        ): Promise<ToolApprovalRequest | null> {
            return createBrowserApprovalRequest(this.id as BrowserToolId, args);
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

    return [new BrowserUnifiedTool()];
}
