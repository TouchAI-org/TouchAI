import type { BuiltInBashExecutionResponse } from '@services/NativeService';
import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BASH_TOOL_CONFIG } from '@/services/BuiltInToolService/tools/bash/constants';
import { executeBashTool } from '@/services/BuiltInToolService/tools/bash/index';
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
});
