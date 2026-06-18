// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { BuiltInBashExecutionResponse } from '@services/NativeService';
import { desktopDir } from '@tauri-apps/api/path';

import { t, tt } from '@/i18n';

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
    const normalizedSeparators = path.trim().replace(/\//g, '\\').replace(/\\+$/, '');
    const uncMatch = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(normalizedSeparators);
    const driveMatch = /^([a-zA-Z]:)(?:\\(.*))?$/.exec(normalizedSeparators);
    const hasRoot = normalizedSeparators.startsWith('\\');
    const prefix =
        uncMatch && uncMatch[1] && uncMatch[2]
            ? `\\\\${uncMatch[1].toLowerCase()}\\${uncMatch[2].toLowerCase()}`
            : (driveMatch?.[1]?.toLowerCase() ?? (hasRoot ? '\\' : ''));
    const body = uncMatch
        ? (uncMatch[3] ?? '')
        : driveMatch
          ? (driveMatch[2] ?? '')
          : normalizedSeparators.replace(/^\\+/, '');
    const resolvedSegments: string[] = [];

    for (const segment of body.split(/\\+/)) {
        if (!segment || segment === '.') {
            continue;
        }

        if (segment === '..') {
            const lastSegment = resolvedSegments[resolvedSegments.length - 1];
            if (lastSegment && lastSegment !== '..') {
                resolvedSegments.pop();
            } else if (!prefix) {
                resolvedSegments.push(segment);
            }
            continue;
        }

        resolvedSegments.push(segment.toLowerCase());
    }

    const normalizedBody = resolvedSegments.join('\\');
    if (!prefix) {
        return normalizedBody;
    }

    if (!normalizedBody) {
        return prefix;
    }

    return prefix.endsWith('\\') ? `${prefix}${normalizedBody}` : `${prefix}\\${normalizedBody}`;
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
        throw new Error(t('builtInTools.bash.error.defaultWorkingDirectoryRequired'));
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
        throw new Error(
            t('builtInTools.bash.error.workingDirectoryOutsideAllowlist', {
                workingDirectory,
            })
        );
    }

    return { command, workingDirectory, rawOutput: parsedArgs.rawOutput ?? false };
}

export function truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) {
        return output;
    }
    return `${output.slice(0, maxLength)}\n\n${tt('[正文已截断，共 {count} 个字符]', {
        count: output.length,
    })}`;
}

export interface ParsedBashToolResult {
    shell: string | null;
    duration: string | null;
    output: string | null;
    compressed: boolean;
}

const EMPTY_BASH_OUTPUT_MARKERS = new Set([
    '[命令无输出]',
    '[No command output]',
    'No output',
    '[No output]',
]);

export function isEmptyBashOutputText(output: string | null | undefined): boolean {
    const normalizedOutput = output?.trim();
    return !normalizedOutput || EMPTY_BASH_OUTPUT_MARKERS.has(normalizedOutput);
}

export function formatBashToolResult(
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

export function parseBashToolResult(result?: string): ParsedBashToolResult {
    const raw = result?.trim();
    if (!raw) {
        return {
            shell: null,
            duration: null,
            output: null,
            compressed: false,
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
        compressed: false,
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

        if (line === 'Compressed: true') {
            meta.compressed = true;
            matchedHeader = true;
        }
    }

    if (!matchedHeader) {
        meta.output = normalized;
    }

    return meta;
}
