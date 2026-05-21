// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { BuiltInBashExecutionResponse } from '@services/NativeService';
import { desktopDir } from '@tauri-apps/api/path';

import { parseToolArguments, parseToolConfigJson } from '../../utils/toolSchema';
import {
    BASH_TOOL_NAME,
    type BashCommandContext,
    bashCommandContextSchema,
    type BashToolConfig,
    bashToolConfigSchema,
    DEFAULT_BASH_TOOL_CONFIG,
} from './constants';

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

/**
 * 解析 Bash 工具配置，并对可控范围做兜底裁剪。
 *
 * @param configJson 数据库存储的配置 JSON。
 * @returns 标准化后的工具配置。
 */
export function parseBashToolConfig(configJson: string | null): BashToolConfig {
    return parseToolConfigJson(bashToolConfigSchema, configJson, DEFAULT_BASH_TOOL_CONFIG);
}

async function resolveDefaultWorkingDirectory(config: BashToolConfig): Promise<string> {
    if (config.defaultWorkingDirectory.trim()) {
        return config.defaultWorkingDirectory;
    }

    const desktopPath = (await desktopDir()).trim().replace(/[\\/]+$/, '');
    if (!desktopPath) {
        throw new Error('Bash tool requires a default working directory.');
    }

    return desktopPath;
}

/**
 * 把模型传入的参数整理为可直接执行的命令上下文。
 *
 * @param args 工具参数。
 * @param config 当前 Bash 工具配置。
 * @returns 已校验的命令与工作目录。
 */
export async function resolveCommandContext(args: Record<string, unknown>, config: BashToolConfig) {
    const parsedArgs = parseToolArguments(BASH_TOOL_NAME, bashCommandContextSchema, args);
    const command = parsedArgs.command;
    const requestedDirectory = parsedArgs.workingDirectory;
    const workingDirectory = requestedDirectory || (await resolveDefaultWorkingDirectory(config));

    if (!isWithinAllowedDirectory(workingDirectory, config.allowedWorkingDirectories)) {
        throw new Error(`Working directory is outside the allowed scope: ${workingDirectory}`);
    }

    return { command, workingDirectory };
}

export function truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) {
        return output;
    }
    return `${output.slice(0, maxLength)}\n\n[输出已截断，共 ${output.length} 个字符]`;
}

export interface ParsedBashToolResult {
    shell: string | null;
    duration: string | null;
    output: string | null;
}

export function formatBashToolResult(
    response: BuiltInBashExecutionResponse,
    commandContext: BashCommandContext,
    maxOutputChars: number
): string {
    const header = [
        `Shell: ${response.shell}`,
        `Working directory: ${commandContext.workingDirectory}`,
        `Exit code: ${response.exitCode ?? 'none'}`,
        `Duration: ${response.durationMs}ms`,
    ].join('\n');
    const output = truncateOutput(response.combinedOutput.trim(), maxOutputChars);

    return [header, '', output || '[命令无输出]'].join('\n');
}

export function parseBashToolResult(result?: string): ParsedBashToolResult {
    const raw = result?.trim();
    if (!raw) {
        return {
            shell: null,
            duration: null,
            output: null,
        };
    }

    const normalized = raw.replace(/\r\n/g, '\n');
    const splitIndex = normalized.indexOf('\n\n');
    const headerText = splitIndex >= 0 ? normalized.slice(0, splitIndex) : normalized;
    const outputText = splitIndex >= 0 ? normalized.slice(splitIndex + 2).trim() : null;
    const headerLines = headerText.split('\n');
    const meta: ParsedBashToolResult = {
        shell: null,
        duration: null,
        output: outputText,
    };
    let matchedHeader = false;

    for (const line of headerLines) {
        if (line.startsWith('Shell: ')) {
            meta.shell = line.slice('Shell: '.length).trim() || null;
            matchedHeader = true;
            continue;
        }

        if (line.startsWith('Duration: ')) {
            const value = line.slice('Duration: '.length).trim();
            meta.duration = value || null;
            matchedHeader = true;
        }
    }

    if (!matchedHeader) {
        meta.output = normalized;
    }

    return meta;
}
