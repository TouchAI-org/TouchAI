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

describe('user runs a shell command from the assistant', () => {
    beforeEach(() => {
        mockBashExecute();
    });

    it('user sees raw output on when requested', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool({ command: 'git status', rawOutput: true }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ rawOutput: true }),
        });
    });

    it('user sees raw output off when requested', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool({ command: 'git status', rawOutput: false }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ rawOutput: false }),
        });
    });

    it('user sees raw output off by default', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ rawOutput: false }),
        });
    });

    it('user sees the output compaction choice passed to the shell', async () => {
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

    it('user sees output compaction off when the config disables it', async () => {
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

    it('user sees the execution id passed to the shell', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool({ command: 'dir' }, config, fakeContext());

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({ executionId: 'call-1' }),
        });
    });

    it('user sees the configured timeout passed to the shell', async () => {
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

    it('user sees the model shorten the timeout within the ceiling', async () => {
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

    it('user sees a model request capped at the configured ceiling', async () => {
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

    it('user sees a below-minimum request ignored instead of killing the command', async () => {
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

    it('user sees the model extend up to the executor limit when the config allows it', async () => {
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

    it('user sees the configured timeout used when the model requests nothing', async () => {
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

    it('user sees a zero timeout passed through to disable it', async () => {
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

    it('user sees a model suggestion ignored when timeouts are disabled', async () => {
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

    it('user sees the full request shape with both output options', async () => {
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

describe('user sees how long a shell command may run', () => {
    it('user sees the configured timeout advertised as the ceiling', () => {
        const definition = bashTool.buildToolDefinition('builtin__bash', {
            ...DEFAULT_BASH_TOOL_CONFIG,
            timeoutMs: 30000,
        });

        expect(definition).toMatchObject({
            name: 'builtin__bash',
            adaptiveTimeoutCeilingMs: 30000,
        });
    });

    it('user sees the executor limit advertised when the config allows it', () => {
        const definition = bashTool.buildToolDefinition('builtin__bash', DEFAULT_BASH_TOOL_CONFIG);

        expect(definition.adaptiveTimeoutCeilingMs).toBe(BASH_TOOL_TIMEOUT_MAX_MS);
    });

    it('user sees no ceiling advertised when timeouts are disabled', () => {
        const definition = bashTool.buildToolDefinition('builtin__bash', {
            ...DEFAULT_BASH_TOOL_CONFIG,
            timeoutMs: 0,
        });

        expect(definition.adaptiveTimeoutCeilingMs).toBeUndefined();
    });

    it('user sees no ceiling advertised below the shared minimum', () => {
        const definition = bashTool.buildToolDefinition('builtin__bash', {
            ...DEFAULT_BASH_TOOL_CONFIG,
            timeoutMs: 500,
        });

        expect(definition.adaptiveTimeoutCeilingMs).toBeUndefined();
    });
});

describe('user approves a risky shell command', () => {
    it('user sees no approval when approval mode is never', async () => {
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

    it('user sees approval requested for risky commands and always mode', async () => {
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

    it('user sees no approval for a safe command in high-risk mode', async () => {
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

describe('user runs the shell tool end to end', () => {
    it('user sees config parsing, semantics, approval, and execution applied in one call', async () => {
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
