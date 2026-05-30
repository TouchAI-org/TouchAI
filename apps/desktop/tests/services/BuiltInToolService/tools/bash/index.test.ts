import type { BuiltInBashExecutionResponse } from '@services/NativeService';
import { getLastTauriInvokeCall, getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BASH_TOOL_CONFIG } from '@/services/BuiltInToolService/tools/bash/constants';
import {
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

function fakeContext(): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        signal: undefined,
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
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

    it('blocks file mutations by default before native execution', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        const result = await executeBashTool(
            { command: 'Set-Content file.txt value' },
            config,
            fakeContext()
        );

        expect(result).toEqual(
            expect.objectContaining({
                isError: true,
                status: 'error',
                result: expect.stringContaining('Bash file mutation blocked'),
            })
        );
        expect(getTauriInvokeCalls('built_in_tools_execute_bash')).toHaveLength(0);
    });

    it('allows file mutations when explicitly requested for Bash', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await executeBashTool(
            { command: 'Set-Content file.txt value', allowFileMutation: true },
            config,
            fakeContext()
        );

        const call = getLastTauriInvokeCall('built_in_tools_execute_bash');
        expect(call?.payload).toEqual({
            request: expect.objectContaining({
                command: 'Set-Content file.txt value',
            }),
        });
    });
});

describe('createBashApprovalRequest file mutation guard', () => {
    it('does not ask for Bash approval when file mutation should be handled by ApplyPatch', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        await expect(
            createBashApprovalRequest({ command: 'Set-Content file.txt value' }, config)
        ).resolves.toBeNull();
    });

    it('uses the existing high-risk approval when shell file mutation is explicitly allowed', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };
        const approval = await createBashApprovalRequest(
            { command: 'Set-Content file.txt value', allowFileMutation: true },
            config
        );

        expect(approval).toEqual(
            expect.objectContaining({
                command: 'Set-Content file.txt value',
            })
        );
    });
});
