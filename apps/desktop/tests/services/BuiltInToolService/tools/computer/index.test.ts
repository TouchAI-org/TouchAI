import { getLastTauriInvokeCall, getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_COMPUTER_TOOL_CONFIG,
    executeComputerActTool,
    executeComputerObserveTool,
    executeComputerSessionTool,
    parseComputerToolConfig,
} from '@/services/BuiltInToolService/tools/computer';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';
import type {
    ComputerActionResponse,
    ComputerObservationResponse,
    ComputerSessionResponse,
} from '@/services/NativeService';

const SESSION_RESPONSE: ComputerSessionResponse = {
    sessionId: 'session-call-1',
    status: 'ready',
    capabilities: {
        platform: 'windows',
        lanes: ['native_tree', 'vision_fallback'],
        routes: ['win32.send_input', 'win32.message', 'screen.capture'],
        background: {
            supported: true,
            routes: ['win32.message'],
            limitations: ['Only native window targets can be background-safe.'],
        },
        grounding: {
            tree: true,
            screenshot: true,
            clickPrediction: false,
            externalProviders: ['cua', 'omniparser', 'ui_tars'],
        },
    },
    target: {
        scope: 'foreground',
        label: 'Focused window',
    },
};

const OBSERVE_RESPONSE: ComputerObservationResponse = {
    observationId: 'obs-1',
    sessionId: 'session-call-1',
    platform: 'windows',
    target: {
        scope: 'foreground',
        label: 'Calculator',
    },
    displays: [
        {
            id: 'display-1',
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scaleFactor: 1,
            primary: true,
        },
    ],
    windows: [
        {
            elementId: 'window:100',
            title: 'Calculator',
            processName: 'Calculator.exe',
            bounds: { x: 100, y: 100, width: 400, height: 320 },
            focused: true,
            visible: true,
            native: true,
        },
    ],
    tree: {
        lane: 'native_tree',
        elements: [
            {
                elementId: 'window:100',
                role: 'window',
                name: 'Calculator',
                bounds: { x: 100, y: 100, width: 400, height: 320 },
                states: ['focused'],
            },
        ],
    },
    screenshot: {
        format: 'png',
        width: 1920,
        height: 1080,
        dataBase64: 'abc',
    },
    warnings: [],
};

const ACTION_RESPONSE: ComputerActionResponse = {
    actionId: 'act-1',
    sessionId: 'session-call-1',
    operation: 'click',
    route: 'win32.send_input',
    lane: 'native_tree',
    backgroundSafe: false,
    cursorMoved: true,
    foregroundChanged: true,
    targetResolved: {
        x: 120,
        y: 130,
        elementId: 'window:100',
        confidence: 1,
    },
    status: 'success',
    warnings: [],
};

function fakeContext(overrides: Partial<BaseBuiltInToolExecutionContext> = {}) {
    return {
        callId: 'call-1',
        signal: undefined,
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
        ...overrides,
    } satisfies BaseBuiltInToolExecutionContext;
}

describe('computer built-in tools', () => {
    beforeEach(() => {
        mockTauriCommand('built_in_tools_computer_session', SESSION_RESPONSE);
        mockTauriCommand('built_in_tools_computer_observe', OBSERVE_RESPONSE);
        mockTauriCommand('built_in_tools_computer_act', ACTION_RESPONSE);
    });

    it('starts a native-first computer session with capability preferences', async () => {
        const result = await executeComputerSessionTool(
            {
                target: { scope: 'foreground' },
                capabilities: ['native_tree', 'screenshot', 'background_actions'],
                reason: 'operate the focused app',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Computer session ready');
        expect(result.result).toContain('native_tree');
        expect(getLastTauriInvokeCall('built_in_tools_computer_session')?.payload).toEqual({
            request: {
                sessionId: 'session-call-1',
                target: { scope: 'foreground' },
                capabilities: ['native_tree', 'screenshot', 'background_actions'],
                providerHints: ['native_windows', 'external_adapter'],
                reason: 'operate the focused app',
                timeoutMs: 8000,
            },
        });
    });

    it('observes via tree-first mode while preserving screenshot fallback', async () => {
        const result = await executeComputerObserveTool(
            {
                sessionId: 'session-call-1',
                mode: 'tree_and_screenshot',
                target: { scope: 'foreground' },
                include: ['windows', 'tree', 'screenshot'],
                reason: 'ground the next click',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Observation obs-1');
        expect(result.result).toContain('Calculator');
        expect(getLastTauriInvokeCall('built_in_tools_computer_observe')?.payload).toEqual({
            request: {
                sessionId: 'session-call-1',
                mode: 'tree_and_screenshot',
                target: { scope: 'foreground' },
                include: ['windows', 'tree', 'screenshot'],
                reason: 'ground the next click',
                timeoutMs: 8000,
            },
        });
    });

    it('defaults observation to native tree data without screenshot payloads', async () => {
        const result = await executeComputerObserveTool(
            {
                sessionId: 'session-call-1',
                reason: 'ground the next click',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('built_in_tools_computer_observe')?.payload).toEqual({
            request: {
                sessionId: 'session-call-1',
                mode: 'tree',
                target: { scope: 'foreground' },
                include: ['displays', 'windows', 'tree'],
                reason: 'ground the next click',
                timeoutMs: 8000,
            },
        });
    });

    it('routes native element clicks through foreground SendInput by default', async () => {
        const result = await executeComputerActTool(
            {
                sessionId: 'session-call-1',
                operation: 'click',
                target: { elementId: 'window:100' },
                reason: 'click calculator',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('"route": "win32.send_input"');
        expect(getLastTauriInvokeCall('built_in_tools_computer_act')?.payload).toEqual({
            request: {
                sessionId: 'session-call-1',
                operation: 'click',
                target: { elementId: 'window:100' },
                value: null,
                executionMode: 'foreground',
                reason: 'click calculator',
                routeHint: 'auto',
                timeoutMs: 8000,
                options: {
                    allowBackground: false,
                    dryRun: false,
                    postActionObserve: false,
                },
            },
        });
    });

    it('allows background mode only when the target is a native element', async () => {
        await executeComputerActTool(
            {
                sessionId: 'session-call-1',
                operation: 'click',
                target: { elementId: 'window:100' },
                executionMode: 'background',
                reason: 'click without foreground activation',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );

        expect(getLastTauriInvokeCall('built_in_tools_computer_act')?.payload).toEqual({
            request: expect.objectContaining({
                executionMode: 'background',
                routeHint: 'auto',
                options: expect.objectContaining({
                    allowBackground: true,
                }),
            }),
        });
    });

    it('rejects background mode when the target only names a native scope', async () => {
        const result = await executeComputerActTool(
            {
                sessionId: 'session-call-1',
                operation: 'click',
                target: { scope: 'element' },
                executionMode: 'background',
                reason: 'scope-only background click',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );

        expect(result.isError).toBe(true);
        expect(result.result).toContain(
            'background execution requires a native elementId or windowId target'
        );
        expect(getTauriInvokeCalls('built_in_tools_computer_act')).toHaveLength(0);
    });

    it('rejects partial coordinate targets before native execution', async () => {
        const result = await executeComputerActTool(
            {
                sessionId: 'session-call-1',
                operation: 'click',
                target: { x: 100 },
                reason: 'bad partial coordinate',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );

        expect(result.isError).toBe(true);
        expect(result.result).toContain('target.x and target.y must be provided together');
        expect(getTauriInvokeCalls('built_in_tools_computer_act')).toHaveLength(0);
    });

    it('requires text for type_text and key value for keyboard operations', async () => {
        const typeResult = await executeComputerActTool(
            {
                sessionId: 'session-call-1',
                operation: 'type_text',
                target: { elementId: 'window:100' },
                reason: 'missing text',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );
        const keyResult = await executeComputerActTool(
            {
                sessionId: 'session-call-1',
                operation: 'hotkey',
                target: { elementId: 'window:100' },
                reason: 'missing keys',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext()
        );

        expect(typeResult.isError).toBe(true);
        expect(typeResult.result).toContain('value is required for type_text');
        expect(keyResult.isError).toBe(true);
        expect(keyResult.result).toContain('value is required for hotkey');
        expect(getTauriInvokeCalls('built_in_tools_computer_act')).toHaveLength(0);
    });

    it('rejects the second action in the same turn before native execution', async () => {
        const result = await executeComputerActTool(
            {
                sessionId: 'session-call-1',
                operation: 'click',
                target: { elementId: 'window:100' },
                reason: 'second click',
            },
            DEFAULT_COMPUTER_TOOL_CONFIG,
            fakeContext({
                hasExecutedBuiltInTool: (toolId) => toolId === 'computer_act',
            })
        );

        expect(result.isError).toBe(true);
        expect(result.result).toContain('computer_act can run only once per turn');
        expect(getTauriInvokeCalls('built_in_tools_computer_act')).toHaveLength(0);
    });

    it('keeps configurable defaults conservative and parseable', () => {
        expect(
            parseComputerToolConfig(
                JSON.stringify({
                    timeoutMs: 30000,
                    defaultExecutionMode: 'background',
                    providerHints: ['native_windows', 'cua'],
                    enableVisionFallback: true,
                })
            )
        ).toEqual({
            ...DEFAULT_COMPUTER_TOOL_CONFIG,
            timeoutMs: 30000,
            defaultExecutionMode: 'background',
            providerHints: ['native_windows', 'cua'],
            enableVisionFallback: true,
        });
    });
});
