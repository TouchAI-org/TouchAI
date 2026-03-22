// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { parseToolArguments, parseToolConfigJson } from '../../utils/toolSchema';
import {
    BASH_TOOL_NAME,
    bashCommandContextSchema,
    type BashToolConfig,
    bashToolConfigSchema,
    DEFAULT_BASH_TOOL_CONFIG,
} from './constants';

function normalizeDirectoryPath(path: string): string {
    return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isWithinAllowedDirectory(path: string, allowlist: string[]): boolean {
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

/**
 * 把模型传入的参数整理为可直接执行的命令上下文。
 *
 * @param args 工具参数。
 * @param config 当前 Bash 工具配置。
 * @returns 已校验的命令与工作目录。
 */
export function resolveCommandContext(args: Record<string, unknown>, config: BashToolConfig) {
    const parsedArgs = parseToolArguments(BASH_TOOL_NAME, bashCommandContextSchema, args);
    const command = parsedArgs.command;
    const requestedDirectory = parsedArgs.workingDirectory;
    const workingDirectory = requestedDirectory || config.defaultWorkingDirectory;

    if (!workingDirectory) {
        throw new Error('Bash tool requires a default working directory.');
    }

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
