import type { BuiltInBashExecutionResponse } from '@services/NativeService';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { DEFAULT_BASH_TOOL_CONFIG } from '@/services/BuiltInToolService/tools/bash/constants';
import {
    formatBashToolResult,
    parseBashToolConfig,
    parseBashToolResult,
    resolveCommandContext,
    truncateOutput,
} from '@/services/BuiltInToolService/tools/bash/helper';

const desktopDirMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/path', () => ({
    desktopDir: desktopDirMock,
}));

async function loadBashHelper() {
    vi.resetModules();
    return await import('@/services/BuiltInToolService/tools/bash/helper');
}

async function loadBashConstants() {
    return await import('@/services/BuiltInToolService/tools/bash/constants');
}

afterEach(() => {
    vi.clearAllMocks();
    setLocale('zh-CN');
});

describe('user has shell tool settings that are read', () => {
    it('user sees the default config when no settings are stored', () => {
        const config = parseBashToolConfig(null);
        expect(config.compactOutput).toBe(false);
        expect(config.approvalMode).toBe('high_risk');
        expect(config.timeoutMs).toBe(DEFAULT_BASH_TOOL_CONFIG.timeoutMs);
    });

    it('user sees the no-timeout sentinel kept instead of the default', () => {
        const config = parseBashToolConfig(JSON.stringify({ timeoutMs: 0 }));
        expect(config.timeoutMs).toBe(0);
    });

    it('user sees output compaction turned on from stored settings', () => {
        const config = parseBashToolConfig(JSON.stringify({ compactOutput: true }));
        expect(config.compactOutput).toBe(true);
    });

    it('user sees output compaction turned off from stored settings', () => {
        const config = parseBashToolConfig(JSON.stringify({ compactOutput: false }));
        expect(config.compactOutput).toBe(false);
    });

    it('user sees output compaction off when the stored settings omit it', () => {
        const config = parseBashToolConfig(JSON.stringify({ approvalMode: 'always' }));
        expect(config.compactOutput).toBe(false);
    });

    it('user sees defaults restored from unreadable stored settings', () => {
        const config = parseBashToolConfig('not-json');
        expect(config.compactOutput).toBe(false);
        expect(config).toEqual(DEFAULT_BASH_TOOL_CONFIG);
    });
});

describe('user has a shell command context that is resolved', () => {
    const baseConfig = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };

    it('user sees raw output off when it is not requested', async () => {
        const ctx = await resolveCommandContext({ command: 'dir' }, baseConfig);
        expect(ctx.rawOutput).toBe(false);
    });

    it('user sees raw output on when it is requested', async () => {
        const ctx = await resolveCommandContext({ command: 'dir', rawOutput: true }, baseConfig);
        expect(ctx.rawOutput).toBe(true);
    });

    it('user sees raw output off when it is explicitly off', async () => {
        const ctx = await resolveCommandContext({ command: 'dir', rawOutput: false }, baseConfig);
        expect(ctx.rawOutput).toBe(false);
    });

    it('user sees the command and working directory passed through', async () => {
        const ctx = await resolveCommandContext(
            { command: 'git status', workingDirectory: 'D:/other' },
            baseConfig
        );
        expect(ctx.command).toBe('git status');
        expect(ctx.workingDirectory).toBe('D:/other');
    });

    it('user sees the configured working directory used when none is given', async () => {
        const ctx = await resolveCommandContext({ command: 'dir' }, baseConfig);
        expect(ctx.workingDirectory).toBe('D:/project');
    });

    it('user sees the desktop folder used when no working directory is configured', async () => {
        desktopDirMock.mockResolvedValue('C:\\Users\\test\\Desktop');
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: '' };
        const ctx = await resolveCommandContext({ command: 'dir' }, config);
        expect(ctx.workingDirectory).toBe('C:\\Users\\test\\Desktop');
    });

    it('user sees a command outside the allowed folders rejected', async () => {
        setLocale('en-US');
        const config = {
            ...baseConfig,
            allowedWorkingDirectories: ['D:/allowed'],
        };
        await expect(
            resolveCommandContext({ command: 'dir', workingDirectory: 'D:/other' }, config)
        ).rejects.toThrow('Working directory is outside the allowed scope');
    });

    it('user sees a command inside the allowed folders accepted', async () => {
        const config = {
            ...baseConfig,
            allowedWorkingDirectories: ['D:/project'],
        };
        const ctx = await resolveCommandContext(
            { command: 'dir', workingDirectory: 'D:/project/sub' },
            config
        );
        expect(ctx.workingDirectory).toBe('D:/project/sub');
    });

    it('user sees an empty command rejected', async () => {
        await expect(resolveCommandContext({ command: '' }, baseConfig)).rejects.toThrow();
    });
});

describe('user sees shell commands resolve a working directory', () => {
    it('user sees the desktop folder looked up once and reused', async () => {
        desktopDirMock.mockResolvedValue('C:\\Users\\Tester\\Desktop\\');
        const { resolveCommandContext: resolveFreshContext } = await loadBashHelper();
        const { DEFAULT_BASH_TOOL_CONFIG: freshConfig } = await loadBashConstants();

        await resolveFreshContext({ command: 'Write-Output "alpha"' }, freshConfig);
        await resolveFreshContext({ command: 'Write-Output "beta"' }, freshConfig);

        expect(desktopDirMock).toHaveBeenCalledTimes(1);
    });

    it('user sees the desktop folder lookup retried after a failure', async () => {
        desktopDirMock
            .mockRejectedValueOnce(new Error('desktop unavailable'))
            .mockResolvedValueOnce('C:\\Users\\Tester\\Desktop');
        const { resolveCommandContext: resolveFreshContext } = await loadBashHelper();
        const { DEFAULT_BASH_TOOL_CONFIG: freshConfig } = await loadBashConstants();

        await expect(
            resolveFreshContext({ command: 'Write-Output "alpha"' }, freshConfig)
        ).rejects.toThrow('desktop unavailable');
        await expect(
            resolveFreshContext({ command: 'Write-Output "beta"' }, freshConfig)
        ).resolves.toMatchObject({
            command: 'Write-Output "beta"',
            workingDirectory: 'C:\\Users\\Tester\\Desktop',
        });

        expect(desktopDirMock).toHaveBeenCalledTimes(2);
    });

    it('user sees an in-flight desktop folder lookup shared with the first command', async () => {
        let resolveDesktopPath: ((value: string) => void) | null = null;
        desktopDirMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveDesktopPath = resolve;
                })
        );
        const { prewarmBashToolRuntime, resolveCommandContext: resolveFreshContext } =
            await loadBashHelper();
        const { DEFAULT_BASH_TOOL_CONFIG: freshConfig } = await loadBashConstants();

        const prewarmPromise = prewarmBashToolRuntime();
        const contextPromise = resolveFreshContext(
            { command: 'Write-Output "alpha"' },
            freshConfig
        );

        expect(desktopDirMock).toHaveBeenCalledTimes(1);
        expect(resolveDesktopPath).not.toBeNull();
        resolveDesktopPath!('C:\\Users\\Tester\\Desktop\\');

        await expect(prewarmPromise).resolves.toBe('C:\\Users\\Tester\\Desktop');
        await expect(contextPromise).resolves.toMatchObject({
            command: 'Write-Output "alpha"',
            workingDirectory: 'C:\\Users\\Tester\\Desktop',
        });
        expect(desktopDirMock).toHaveBeenCalledTimes(1);
    });
});

describe('user sees long command output shortened', () => {
    it('user sees short output kept unchanged', () => {
        expect(truncateOutput('short', 100)).toBe('short');
    });

    it('user sees output over the limit truncated', () => {
        const result = truncateOutput('a'.repeat(150), 100);
        expect(result).toContain('a'.repeat(100));
        expect(result).toContain('150');
    });

    it('user sees output exactly at the limit kept unchanged', () => {
        const output = 'a'.repeat(100);
        expect(truncateOutput(output, 100)).toBe(output);
    });
});

describe('user reads the result of a shell command', () => {
    const response: BuiltInBashExecutionResponse = {
        command: 'dir',
        shell: 'powershell',
        workingDirectory: 'D:/project',
        exitCode: 0,
        success: true,
        timedOut: false,
        cancelled: false,
        durationMs: 42,
        stdout: 'file.txt',
        stderr: '',
        combinedOutput: 'file.txt',
    };

    it('user sees shell, working directory, exit code, and duration in the result', () => {
        const result = formatBashToolResult(
            response,
            {
                command: 'dir',
                workingDirectory: 'D:/project',
                rawOutput: false,
            },
            12000
        );
        expect(result).toContain('powershell');
        expect(result).toContain('D:/project');
        expect(result).toContain('Exit code: 0');
        expect(result).toContain('42ms');
    });

    it('user sees a placeholder when the command printed nothing', () => {
        const empty = { ...response, combinedOutput: '' };
        const result = formatBashToolResult(
            empty,
            {
                command: 'dir',
                workingDirectory: 'D:/project',
                rawOutput: false,
            },
            12000
        );
        expect(result).toContain('[命令无输出]');
    });

    it('user sees no exit code shown when the process reported none', () => {
        const noExit = { ...response, exitCode: null };
        const result = formatBashToolResult(
            noExit,
            {
                command: 'dir',
                workingDirectory: 'D:/project',
                rawOutput: false,
            },
            12000
        );
        expect(result).toContain('Exit code: none');
    });
});

describe('user sees the shell result read back from stored text', () => {
    it('user sees empty fields for empty stored text', () => {
        expect(parseBashToolResult(undefined)).toEqual({
            shell: null,
            duration: null,
            output: null,
            compressed: false,
        });
    });

    it('user sees shell and duration read from the stored header', () => {
        const input =
            'Shell: powershell\nWorking directory: D:/p\nExit code: 0\nDuration: 42ms\n\nfile content';
        const result = parseBashToolResult(input);
        expect(result.shell).toBe('powershell');
        expect(result.duration).toBe('42ms');
        expect(result.output).toBe('file content');
        expect(result.compressed).toBe(false);
    });

    it('user sees headerless output treated as raw output', () => {
        const result = parseBashToolResult('just some output');
        expect(result.shell).toBeNull();
        expect(result.output).toBe('just some output');
        expect(result.compressed).toBe(false);
    });

    it('user sees a compressed marker read from the stored header', () => {
        const input =
            'Shell: powershell\nWorking directory: D:/p\nExit code: 0\nDuration: 42ms\nCompressed: true\n\nfiltered output';
        const result = parseBashToolResult(input);
        expect(result.compressed).toBe(true);
        expect(result.output).toBe('filtered output');
    });

    it('user sees the compressed marker included in a compressed result', () => {
        const compressedResponse: BuiltInBashExecutionResponse = {
            command: 'rtk git status',
            shell: 'powershell',
            workingDirectory: 'D:/project',
            exitCode: 0,
            success: true,
            timedOut: false,
            cancelled: false,
            durationMs: 100,
            stdout: 'filtered',
            stderr: '',
            combinedOutput: 'filtered',
            compressed: true,
        };
        const result = formatBashToolResult(
            compressedResponse,
            { command: 'git status', workingDirectory: 'D:/project', rawOutput: false },
            12000
        );
        expect(result).toContain('Compressed: true');
        const parsed = parseBashToolResult(result);
        expect(parsed.compressed).toBe(true);
    });

    it('user sees no compressed marker on an uncompressed result', () => {
        const base: BuiltInBashExecutionResponse = {
            command: 'dir',
            shell: 'powershell',
            workingDirectory: 'D:/project',
            exitCode: 0,
            success: true,
            timedOut: false,
            cancelled: false,
            durationMs: 42,
            stdout: 'file.txt',
            stderr: '',
            combinedOutput: 'file.txt',
        };
        const result = formatBashToolResult(
            base,
            { command: 'dir', workingDirectory: 'D:/project', rawOutput: false },
            12000
        );
        expect(result).not.toContain('Compressed');
    });
});
