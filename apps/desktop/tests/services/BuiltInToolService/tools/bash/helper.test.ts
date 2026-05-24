import type { BuiltInBashExecutionResponse } from '@services/NativeService';
import { describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { DEFAULT_BASH_TOOL_CONFIG } from '@/services/BuiltInToolService/tools/bash/constants';
import {
    formatBashToolResult,
    parseBashToolConfig,
    parseBashToolResult,
    resolveCommandContext,
    truncateOutput,
} from '@/services/BuiltInToolService/tools/bash/helper';

vi.mock('@tauri-apps/api/path', () => ({
    desktopDir: vi.fn().mockResolvedValue('C:\\Users\\test\\Desktop'),
}));

describe('parseBashToolConfig', () => {
    it('returns default config when input is null', () => {
        const config = parseBashToolConfig(null);
        expect(config.compactOutput).toBe(false);
        expect(config.approvalMode).toBe('high_risk');
        expect(config.timeoutMs).toBe(15000);
    });

    it('parses compactOutput true from JSON string', () => {
        const config = parseBashToolConfig(JSON.stringify({ compactOutput: true }));
        expect(config.compactOutput).toBe(true);
    });

    it('parses compactOutput false from JSON string', () => {
        const config = parseBashToolConfig(JSON.stringify({ compactOutput: false }));
        expect(config.compactOutput).toBe(false);
    });

    it('defaults compactOutput to false when not in JSON', () => {
        const config = parseBashToolConfig(JSON.stringify({ approvalMode: 'always' }));
        expect(config.compactOutput).toBe(false);
    });

    it('falls back to defaults on invalid JSON', () => {
        const config = parseBashToolConfig('not-json');
        expect(config.compactOutput).toBe(false);
        expect(config).toEqual(DEFAULT_BASH_TOOL_CONFIG);
    });
});

describe('resolveCommandContext', () => {
    const baseConfig = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: 'D:/project' };

    it('returns rawOutput false when not provided', async () => {
        const ctx = await resolveCommandContext({ command: 'dir' }, baseConfig);
        expect(ctx.rawOutput).toBe(false);
    });

    it('returns rawOutput true when explicitly set', async () => {
        const ctx = await resolveCommandContext({ command: 'dir', rawOutput: true }, baseConfig);
        expect(ctx.rawOutput).toBe(true);
    });

    it('returns rawOutput false when explicitly set', async () => {
        const ctx = await resolveCommandContext({ command: 'dir', rawOutput: false }, baseConfig);
        expect(ctx.rawOutput).toBe(false);
    });

    it('passes through command and workingDirectory', async () => {
        const ctx = await resolveCommandContext(
            { command: 'git status', workingDirectory: 'D:/other' },
            baseConfig
        );
        expect(ctx.command).toBe('git status');
        expect(ctx.workingDirectory).toBe('D:/other');
    });

    it('falls back to defaultWorkingDirectory when not specified', async () => {
        const ctx = await resolveCommandContext({ command: 'dir' }, baseConfig);
        expect(ctx.workingDirectory).toBe('D:/project');
    });

    it('falls back to desktop directory when defaultWorkingDirectory is empty', async () => {
        const config = { ...DEFAULT_BASH_TOOL_CONFIG, defaultWorkingDirectory: '' };
        const ctx = await resolveCommandContext({ command: 'dir' }, config);
        expect(ctx.workingDirectory).toBe('C:\\Users\\test\\Desktop');
    });

    it('rejects command outside allowed directories', async () => {
        setLocale('en-US');
        const config = {
            ...baseConfig,
            allowedWorkingDirectories: ['D:/allowed'],
        };
        await expect(
            resolveCommandContext({ command: 'dir', workingDirectory: 'D:/other' }, config)
        ).rejects.toThrow('Working directory is outside the allowed scope');
    });

    it('accepts command inside allowed directories', async () => {
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

    it('rejects empty command', async () => {
        await expect(resolveCommandContext({ command: '' }, baseConfig)).rejects.toThrow();
    });
});

describe('truncateOutput', () => {
    it('returns output unchanged when under limit', () => {
        expect(truncateOutput('short', 100)).toBe('short');
    });

    it('truncates output exceeding the limit', () => {
        const result = truncateOutput('a'.repeat(150), 100);
        expect(result).toContain('a'.repeat(100));
        expect(result).toContain('150');
    });

    it('returns output at exact limit unchanged', () => {
        const output = 'a'.repeat(100);
        expect(truncateOutput(output, 100)).toBe(output);
    });
});

describe('formatBashToolResult', () => {
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

    it('includes shell, working directory, exit code, and duration', () => {
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

    it('shows placeholder for empty output', () => {
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
        expect(result).toContain('命令无输出');
    });

    it('uses none when exitCode is null', () => {
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

describe('parseBashToolResult', () => {
    it('returns null fields for empty input', () => {
        expect(parseBashToolResult(undefined)).toEqual({
            shell: null,
            duration: null,
            output: null,
            compressed: false,
        });
    });

    it('parses shell and duration from header', () => {
        const input =
            'Shell: powershell\nWorking directory: D:/p\nExit code: 0\nDuration: 42ms\n\nfile content';
        const result = parseBashToolResult(input);
        expect(result.shell).toBe('powershell');
        expect(result.duration).toBe('42ms');
        expect(result.output).toBe('file content');
        expect(result.compressed).toBe(false);
    });

    it('treats no-header output as raw output', () => {
        const result = parseBashToolResult('just some output');
        expect(result.shell).toBeNull();
        expect(result.output).toBe('just some output');
        expect(result.compressed).toBe(false);
    });

    it('parses Compressed: true from header', () => {
        const input =
            'Shell: powershell\nWorking directory: D:/p\nExit code: 0\nDuration: 42ms\nCompressed: true\n\nfiltered output';
        const result = parseBashToolResult(input);
        expect(result.compressed).toBe(true);
        expect(result.output).toBe('filtered output');
    });

    it('includes Compressed line in formatBashToolResult when compressed', () => {
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

    it('does not include Compressed line when not compressed', () => {
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
