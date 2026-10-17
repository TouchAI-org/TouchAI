import type { BuiltInBashExecutionResponse } from '@services/NativeService';
import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    BASH_TOOL_TIMEOUT_MAX_MS,
    DEFAULT_BASH_TOOL_CONFIG,
} from '@/services/BuiltInToolService/tools/bash/constants';
import {
    bashTool,
    createBashApprovalRequest,
    executeBashTool,
} from '@/services/BuiltInToolService/tools/bash/index';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';

vi.mock('@tauri-apps/api/path', () => ({
    desktopDir: vi.fn().mockResolvedValue('C:\\Users\\test\\Desktop'),
}));

const MOCK_RESPONSE: BuiltInBashExecutionResponse = {
    command: 'dir',
    shell: 'powershell',
    workingDirectory: 'D:/project',
    exitCode: 0,
    success: true,
    timedOut: false,
    cancelled: false,
    durationMs: 10,
    stdout: 'ok',
    stderr: '',
    combinedOutput: 'ok',
};

function mockBashExecute() {
    mockTauriCommand('built_in_tools_execute_bash', MOCK_RESPONSE);
}

function fakeContext(
    overrides: Partial<BaseBuiltInToolExecutionContext> = {}
): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        signal: undefined,
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
        ...overrides,
    };
}

describe('executeBashTool request construction', () => {
    beforeEach(() => {
        mockBashExecute();
    });

    it('passes rawOutput true to the native request', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool({ command: 'git status', rawOutput: true }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ rawOutput: true }),
        });
    });

    it('passes rawOutput false to the native request', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool({ command: 'git status', rawOutput: false }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ rawOutput: false }),
        });
    });

    it('defaults rawOutput to false when omitted', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ rawOutput: false }),
        });
    });

    it('passes compactOutput from config to the native request', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            compactOutput: true,
        };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ compactOutput: true }),
        });
    });

    it('passes compactOutput false when disabled in config', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            compactOutput: false,
        };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ compactOutput: false }),
        });
    });

    it('includes executionId from context', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ executionId: 'call-1' }),
        });
    });

    it('includes timeoutMs from config', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            timeoutMs: 30000,
        };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ timeoutMs: 30000 }),
        });
    });

    it('lets the model shorten the timeout within the configured ceiling', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            timeoutMs: 30000,
        };
        await executeBashTool(
            { command: 'dir' },
            config,
            fakeContext({ requestedTimeoutMs: 5000 })
        );

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ timeoutMs: 5000 }),
        });
    });

    it('caps a model request at the configured ceiling', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            timeoutMs: 15000,
        };
        await executeBashTool(
            { command: 'dir' },
            config,
            fakeContext({ requestedTimeoutMs: 600000 })
        );

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ timeoutMs: 15000 }),
        });
    });

    it('ignores a below-floor model request instead of killing the command after 1s', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            timeoutMs: 30000,
        };
        await executeBashTool({ command: 'dir' }, config, fakeContext({ requestedTimeoutMs: 0 }));

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ timeoutMs: 30000 }),
        });
    });

    it('lets the model extend up to the executor limit when the config allows it', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            timeoutMs: BASH_TOOL_TIMEOUT_MAX_MS,
        };
        await executeBashTool(
            { command: 'dir' },
            config,
            fakeContext({ requestedTimeoutMs: 600000 })
        );

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ timeoutMs: BASH_TOOL_TIMEOUT_MAX_MS }),
        });
    });

    it('falls back to the configured timeout when no model request is present', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            timeoutMs: 22000,
        };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ timeoutMs: 22000 }),
        });
    });

    it('passes 0 through so the native layer disables the timeout', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            timeoutMs: 0,
        };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ timeoutMs: 0 }),
        });
    });

    it('ignores a model suggestion when the timeout is disabled', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            timeoutMs: 0,
        };
        await executeBashTool(
            { command: 'dir' },
            config,
            fakeContext({ requestedTimeoutMs: 5000 })
        );

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ timeoutMs: 0 }),
        });
    });

    it('sends the full request shape with both compactOutput and rawOutput', async () => {
        const config = {
            ...DEFAULT_BASH_TOOL_CONFIG,
            defaultWorkingDirectory: 'D:/project',
            compactOutput: true,
            timeoutMs: 20000,
        };
        await executeBashTool(
            { command: 'git diff', rawOutput: true, workingDirectory: 'D:/other' },
            config,
            fakeContext()
        );

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: {
                executionId: 'call-1',
                command: 'git diff',
                workingDirectory: 'D:/other',
                timeoutMs: 20000,
                compactOutput: true,
                rawOutput: true,
            },
        });
    });
});

describe('bashTool adaptive timeout ceiling', () => {
    it('advertises the configured timeout as the ceiling', () => {
        const definition = bashTool.buildToolDefinition('builtin__bash', {
            ...DEFAULT_BASH_TOOL_CONFIG,
            timeoutMs: 30000,
        });

        expect(definition).toMatchObject({
            name: 'builtin__bash',
            adaptiveTimeoutCeilingMs: 30000,
        });
    });

    it('advertises the executor limit when the config allows it', () => {
        const definition = bashTool.buildToolDefinition('builtin__bash', DEFAULT_BASH_TOOL_CONFIG);

        expect(definition.adaptiveTimeoutCeilingMs).toBe(BASH_TOOL_TIMEOUT_MAX_MS);
    });

    it('does not advertise a ceiling when the timeout is disabled', () => {
        const definition = bashTool.buildToolDefinition('builtin__bash', {
            ...DEFAULT_BASH_TOOL_CONFIG,
            timeoutMs: 0,
        });

        expect(definition.adaptiveTimeoutCeilingMs).toBeUndefined();
    });

    it('does not advertise a ceiling below the shared minimum', () => {
        const definition = bashTool.buildToolDefinition('builtin__bash', {
            ...DEFAULT_BASH_TOOL_CONFIG,
            timeoutMs: 500,
        });

        expect(definition.adaptiveTimeoutCeilingMs).toBeUndefined();
    });
});

describe('createBashApprovalRequest', () => {
    it('skips approval when approval mode is never', async () => {
        await expect(
            createBashApprovalRequest(
                {
                    command: 'Write-Output "alpha"',
                    reason: 'Read a file',
                    workingDirectory: 'D:/Project/TouchAI',
                },
                {
                    ...DEFAULT_BASH_TOOL_CONFIG,
                    approvalMode: 'never',
                }
            )
        ).resolves.toBeNull();
    });

    it('requests approval for high-risk commands and always mode', async () => {
        await expect(
            createBashApprovalRequest(
                {
                    command: 'Remove-Item test.txt',
                    reason: 'Need cleanup',
                    workingDirectory: 'D:/Project/TouchAI',
                },
                DEFAULT_BASH_TOOL_CONFIG
            )
        ).resolves.toMatchObject({
            title: '命令执行确认',
            reason: '命令可能删除文件或目录。',
            command: 'Remove-Item test.txt',
        });

        await expect(
            createBashApprovalRequest(
                {
                    command: 'Write-Output "alpha"',
                    reason: 'Need visibility',
                    workingDirectory: 'D:/Project/TouchAI',
                },
                {
                    ...DEFAULT_BASH_TOOL_CONFIG,
                    approvalMode: 'always',
                }
            )
        ).resolves.toMatchObject({
            title: '命令执行确认',
            reason: '当前配置要求所有 Bash 命令都必须先批准。',
            command: 'Write-Output "alpha"',
        });
    });

    it('does not request approval for a safe command in high-risk mode', async () => {
        await expect(
            createBashApprovalRequest(
                {
                    command: 'Write-Output "alpha"',
                    reason: 'Need visibility',
                    workingDirectory: 'D:/Project/TouchAI',
                },
                DEFAULT_BASH_TOOL_CONFIG
            )
        ).resolves.toBeNull();
    });
});

describe('bashTool', () => {
    it('delegates config parsing, semantic building, approval creation, and execution', async () => {
        mockBashExecute();

        expect(bashTool.parseConfig(null)).toEqual(DEFAULT_BASH_TOOL_CONFIG);
        expect(
            bashTool.buildConversationSemantic({
                command: '  Write-Output   "alpha"  ',
            })
        ).toEqual({
            action: 'run',
            target: 'Write-Output "alpha"',
        });
        await expect(
            bashTool.buildApprovalRequest(
                {
                    command: 'Remove-Item test.txt',
                    reason: 'Need cleanup',
                    workingDirectory: 'D:/Project/TouchAI',
                },
                DEFAULT_BASH_TOOL_CONFIG
            )
        ).resolves.toMatchObject({
            reason: '命令可能删除文件或目录。',
        });

        await expect(
            bashTool.execute(
                {
                    command: 'Write-Output "alpha"',
                    workingDirectory: 'D:/Project/TouchAI',
                },
                DEFAULT_BASH_TOOL_CONFIG,
                fakeContext({ callId: 'call-bash-tool' })
            )
        ).resolves.toMatchObject({
            status: 'success',
            isError: false,
        });
    });
});
