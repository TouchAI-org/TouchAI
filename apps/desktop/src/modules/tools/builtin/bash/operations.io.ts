import { desktopDir } from '@/platform/files';
// Copyright (c) 2026. 千诚. Licensed under GPL v3
import type { BuiltInBashExecutionResponse } from '@/platform/native';

import type { ToolMessages } from '../../contracts/host';
import { parseToolArguments } from '../../execution/schema';
import { parseBashToolConfig } from './configuration';
import {
    BASH_TOOL_NAME,
    type BashCommandContext,
    bashCommandContextSchema,
    type BashToolConfig,
} from './constants';
import { isEmptyBashOutputText, parseBashToolResult } from './presentation';

export function createBashOperations(messages: ToolMessages) {
    const { t, tt } = messages;
    let cachedDesktopDirectoryPromise: Promise<string> | null = null;

    function normalizeDirectoryPath(path: string): string {
        return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    }

    function isWithinAllowedDirectory(path: string, allowlist: string[]): boolean {
        if (allowlist.length === 0) {
            return true;
        }

        const normalizedPath = normalizeDirectoryPath(path);
        return allowlist.some((allowedPath) => {
            const normalizedAllowed = normalizeDirectoryPath(allowedPath);
            return (
                normalizedPath === normalizedAllowed ||
                normalizedPath.startsWith(`${normalizedAllowed}\\`)
            );
        });
    }

    async function loadDesktopWorkingDirectory(): Promise<string> {
        try {
            const desktopPath = (await desktopDir()).trim().replace(/[\\/]+$/, '');
            if (!desktopPath) {
                throw new Error('Bash tool requires a default working directory.');
            }

            return desktopPath;
        } catch (error) {
            cachedDesktopDirectoryPromise = null;
            throw error;
        }
    }

    async function resolveDesktopWorkingDirectory(): Promise<string> {
        if (!cachedDesktopDirectoryPromise) {
            cachedDesktopDirectoryPromise = loadDesktopWorkingDirectory();
        }

        return cachedDesktopDirectoryPromise;
    }

    async function prewarmBashToolRuntime(): Promise<string> {
        return resolveDesktopWorkingDirectory();
    }

    async function resolveDefaultWorkingDirectory(config: BashToolConfig): Promise<string> {
        if (config.defaultWorkingDirectory.trim()) {
            return config.defaultWorkingDirectory;
        }

        return resolveDesktopWorkingDirectory();
    }

    /**
     * 把模型传入的参数整理为可直接执行的命令上下文。
     *
     * @param args 工具参数。
     * @param config 当前 Bash 工具配置。
     * @returns 已校验的命令与工作目录。
     */
    async function resolveCommandContext(args: Record<string, unknown>, config: BashToolConfig) {
        const parsedArgs = parseToolArguments(BASH_TOOL_NAME, bashCommandContextSchema, args);
        const command = parsedArgs.command;
        const requestedDirectory = parsedArgs.workingDirectory;
        const workingDirectory =
            requestedDirectory || (await resolveDefaultWorkingDirectory(config));

        if (!isWithinAllowedDirectory(workingDirectory, config.allowedWorkingDirectories)) {
            throw new Error(
                t('builtInTools.bash.error.workingDirectoryOutsideAllowlist', {
                    workingDirectory,
                })
            );
        }

        return { command, workingDirectory, rawOutput: parsedArgs.rawOutput ?? false };
    }

    function truncateOutput(output: string, maxLength: number): string {
        if (output.length <= maxLength) {
            return output;
        }
        return `${output.slice(0, maxLength)}\n\n${tt('[正文已截断，共 {count} 个字符]', {
            count: output.length,
        })}`;
    }

    function formatBashToolResult(
        response: BuiltInBashExecutionResponse,
        commandContext: BashCommandContext,
        maxOutputChars: number
    ): string {
        const headerLines = [
            `Shell: ${response.shell}`,
            `Working directory: ${commandContext.workingDirectory}`,
            `Exit code: ${response.exitCode ?? 'none'}`,
            `Duration: ${response.durationMs}ms`,
        ];
        if (response.compressed) {
            headerLines.push('Compressed: true');
        }
        const header = headerLines.join('\n');
        const output = truncateOutput(response.combinedOutput.trim(), maxOutputChars);

        return [header, '', isEmptyBashOutputText(output) ? tt('[命令无输出]') : output].join('\n');
    }

    return {
        parseBashToolConfig,
        resolveCommandContext,
        prewarmBashToolRuntime,
        formatBashToolResult,
        parseBashToolResult,
        isEmptyBashOutputText,
    };
}
