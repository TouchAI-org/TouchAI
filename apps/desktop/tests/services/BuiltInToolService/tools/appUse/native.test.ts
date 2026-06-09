import { getLastTauriInvokeCall, getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_APP_USE_TOOL_CONFIG } from '@/services/BuiltInToolService/tools/appUse';
import {
    appActTool,
    appObserveTool,
    appSessionTool,
    executeAppActTool,
    executeAppObserveTool,
    executeAppSessionTool,
} from '@/services/BuiltInToolService/tools/appUse/tool';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';
import type {
    AppUseNativeActResponse,
    AppUseNativeAuthorizeActResponse,
    AppUseNativeObserveResponse,
    AppUseNativeSessionResponse,
} from '@/services/NativeService';

function fakeContext(): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-app-use-1',
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
    };
}

describe('App Use native bridge construction', () => {
    beforeEach(() => {
        mockTauriCommand('app_use_session', {
            ok: true,
            operation: 'discover',
            adapters: [],
            message: null,
        } satisfies AppUseNativeSessionResponse);
        mockTauriCommand('app_use_observe', {
            ok: true,
            adapterId: 'wps_writer',
            scope: 'selection',
            target: null,
            content: 'selected text',
            metadata: {},
            truncated: false,
        } satisfies AppUseNativeObserveResponse);
        mockTauriCommand('app_use_act', {
            ok: true,
            adapterId: 'wps_writer',
            action: 'replace_document_text',
            receipt: 'replaced document text',
            changed: true,
            metadata: {},
        } satisfies AppUseNativeActResponse);
        mockTauriCommand('app_use_authorize_act', {
            permit: {
                callId: 'call-app-use-1',
                adapterId: 'wps_writer',
                action: 'replace_document_text',
                targetId: 'owned-document-1',
                parametersHash: 'hash-1',
                token: 'permit-1',
            },
            expiresInMs: 30000,
        } satisfies AppUseNativeAuthorizeActResponse);
    });

    it('passes App Use settings and call id to app_session', async () => {
        await executeAppSessionTool(
            { operation: 'discover', description: '列出软件控制能力' },
            DEFAULT_APP_USE_TOOL_CONFIG,
            fakeContext()
        );

        expect(getLastTauriInvokeCall('app_use_session')?.payload).toEqual({
            request: {
                executionId: 'call-app-use-1',
                operation: 'discover',
                description: '列出软件控制能力',
                adapterId: undefined,
                targetKind: undefined,
                config: DEFAULT_APP_USE_TOOL_CONFIG,
            },
        });
    });

    it('passes create_owned_target session fields to app_session', async () => {
        await executeAppSessionTool(
            {
                operation: 'create_owned_target',
                description: 'create owned spreadsheet target',
                adapterId: 'wps_spreadsheet',
                targetKind: 'spreadsheet',
            },
            DEFAULT_APP_USE_TOOL_CONFIG,
            fakeContext()
        );

        expect(getLastTauriInvokeCall('app_use_session')?.payload).toEqual({
            request: {
                executionId: 'call-app-use-1',
                operation: 'create_owned_target',
                description: 'create owned spreadsheet target',
                adapterId: 'wps_spreadsheet',
                targetKind: 'spreadsheet',
                config: DEFAULT_APP_USE_TOOL_CONFIG,
            },
        });
    });

    it('passes adapter scope and output limit to app_observe', async () => {
        await executeAppObserveTool(
            {
                adapterId: 'wps_writer',
                scope: 'selection',
                description: '读取当前选区',
                maxOutputChars: 3000,
            },
            DEFAULT_APP_USE_TOOL_CONFIG,
            fakeContext()
        );

        expect(getLastTauriInvokeCall('app_use_observe')?.payload).toEqual({
            request: {
                executionId: 'call-app-use-1',
                adapterId: 'wps_writer',
                scope: 'selection',
                description: '读取当前选区',
                targetId: undefined,
                maxOutputChars: 3000,
                config: DEFAULT_APP_USE_TOOL_CONFIG,
            },
        });
    });

    it('authorizes one bounded app action before app_act', async () => {
        const interactiveConfig = { ...DEFAULT_APP_USE_TOOL_CONFIG, mode: 'interactive' as const };
        await executeAppActTool(
            {
                adapterId: 'wps_writer',
                action: 'replace_document_text',
                description: '替换当前选区',
                targetId: 'owned-document-1',
                parameters: { text: 'hello' },
            },
            interactiveConfig,
            fakeContext()
        );

        expect(getLastTauriInvokeCall('app_use_authorize_act')?.payload).toMatchObject({
            request: {
                executionId: 'call-app-use-1',
                adapterId: 'wps_writer',
                action: 'replace_document_text',
                targetId: 'owned-document-1',
                parameters: { text: 'hello' },
                config: interactiveConfig,
            },
        });
        expect(getLastTauriInvokeCall('app_use_act')?.payload).toEqual({
            request: {
                executionId: 'call-app-use-1',
                adapterId: 'wps_writer',
                action: 'replace_document_text',
                description: '替换当前选区',
                targetId: 'owned-document-1',
                parameters: { text: 'hello' },
                permit: {
                    callId: 'call-app-use-1',
                    adapterId: 'wps_writer',
                    action: 'replace_document_text',
                    targetId: 'owned-document-1',
                    parametersHash: 'hash-1',
                    token: 'permit-1',
                },
                config: interactiveConfig,
            },
        });
    });

    it('blocks mutating app actions while App Use is read-only', async () => {
        const result = await executeAppActTool(
            {
                adapterId: 'wps_writer',
                action: 'replace_document_text',
                description: 'replace text in read-only mode',
                targetId: 'owned-document-1',
                parameters: { text: 'hello' },
            },
            DEFAULT_APP_USE_TOOL_CONFIG,
            fakeContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'App Use is in read-only mode',
        });
        expect(getTauriInvokeCalls('app_use_act')).toHaveLength(0);
    });

    it('does not call app_act when native authorization refuses a permit', async () => {
        mockTauriCommand('app_use_authorize_act', {
            permit: null,
            expiresInMs: 0,
        } satisfies AppUseNativeAuthorizeActResponse);
        const interactiveConfig = { ...DEFAULT_APP_USE_TOOL_CONFIG, mode: 'interactive' as const };

        const result = await executeAppActTool(
            {
                adapterId: 'wps_writer',
                action: 'replace_document_text',
                description: 'replace current selection',
                targetId: 'owned-document-1',
                parameters: { text: 'hello' },
            },
            interactiveConfig,
            fakeContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'App Use native authorization failed',
        });
        expect(getTauriInvokeCalls('app_use_act')).toHaveLength(0);
    });

    it('delegates through App Use tool instances and exposes semantic labels', async () => {
        const interactiveConfig = { ...DEFAULT_APP_USE_TOOL_CONFIG, mode: 'interactive' as const };

        expect(appSessionTool.parseConfig(JSON.stringify({ mode: 'interactive' })).mode).toBe(
            'interactive'
        );
        expect(appSessionTool.buildConversationSemantic()).toEqual({
            action: 'process',
            target: 'App Use session',
        });
        expect(appObserveTool.buildConversationSemantic()).toEqual({
            action: 'process',
            target: 'App Use observation',
        });
        expect(appActTool.buildConversationSemantic()).toEqual({
            action: 'process',
            target: 'App Use action',
        });

        const sessionResult = await appSessionTool.execute(
            { operation: 'discover', description: 'list app adapters' },
            DEFAULT_APP_USE_TOOL_CONFIG,
            fakeContext()
        );
        const observeResult = await appObserveTool.execute(
            {
                adapterId: 'wps_writer',
                scope: 'selection',
                description: 'read selection',
                targetId: 'owned-doc',
            },
            DEFAULT_APP_USE_TOOL_CONFIG,
            fakeContext()
        );
        const actResult = await appActTool.execute(
            {
                adapterId: 'wps_writer',
                action: 'replace_document_text',
                description: 'replace document text',
                targetId: 'owned-document-1',
                parameters: { text: 'hello' },
            },
            interactiveConfig,
            fakeContext()
        );

        expect(JSON.parse(sessionResult.result)).toMatchObject({ ok: true, operation: 'discover' });
        expect(JSON.parse(observeResult.result)).toMatchObject({
            ok: true,
            content: 'selected text',
        });
        expect(JSON.parse(actResult.result)).toMatchObject({ ok: true, changed: true });
    });
});
