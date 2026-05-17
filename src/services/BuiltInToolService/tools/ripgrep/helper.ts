// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * Ripgrep 工具的请求构建、JSON 输出解析和结果格式化。
 *
 * buildRipgrepRequest  把模型参数转成 rg 命令行 argv
 * parseRipgrepJsonLines  解析 rg --json 输出为结构化匹配行
 * formatRipgrepResult  拼接人类可读的搜索结果文本
 */

import type {
    BuiltInRipgrepExecutionRequest,
    BuiltInRipgrepExecutionResponse,
} from '@services/NativeService';

import { parseToolArguments } from '../../utils/toolSchema';
import {
    DEFAULT_RIPGREP_MAX_RESULTS,
    DEFAULT_RIPGREP_TIMEOUT_MS,
    RIPGREP_TOOL_NAME,
    ripgrepArgsSchema,
} from './constants';

/** rg --json 输出中单条 match 的解析结果。 */
export interface RipgrepMatchRow {
    path: string;
    lineNumber: number;
    column: number;
    lineText: string;
}

/** 构建请求时一并产出的上下文，供格式化结果时使用。 */
export interface RipgrepRequestContext {
    pattern: string;
    paths: string[];
    requestedMaxResults: number;
    request: BuiltInRipgrepExecutionRequest;
}

/**
 * 把模型传入的参数转为 rg 命令行 argv 和请求上下文。
 *
 * 自动添加 --json、--line-number、--column、--with-filename 等固定参数，
 * 以及按用户选项拼接 --smart-case / --case-sensitive、-g、-t 等可选参数。
 */
export function buildRipgrepRequest(args: Record<string, unknown>): RipgrepRequestContext {
    const parsed = parseToolArguments(RIPGREP_TOOL_NAME, ripgrepArgsSchema, args);
    const requestedMaxResults = parsed.maxResults ?? DEFAULT_RIPGREP_MAX_RESULTS;
    const argv = [
        '--json',
        '--color',
        'never',
        '--line-number',
        '--column',
        '--with-filename',
        '--max-count',
        String(requestedMaxResults),
    ];

    if (parsed.caseSensitive) {
        argv.push('--case-sensitive');
    } else {
        argv.push('--smart-case');
    }
    if (parsed.beforeContext !== undefined) {
        argv.push('--before-context', String(parsed.beforeContext));
    }
    if (parsed.afterContext !== undefined) {
        argv.push('--after-context', String(parsed.afterContext));
    }
    if (parsed.fixedStrings) {
        argv.push('--fixed-strings');
    }
    if (parsed.wordRegexp) {
        argv.push('--word-regexp');
    }
    if (parsed.hidden) {
        argv.push('--hidden');
    }
    if (parsed.followSymlinks) {
        argv.push('--follow');
    }
    for (const glob of parsed.glob ?? []) {
        argv.push('-g', glob);
    }
    for (const fileType of parsed.fileType ?? []) {
        argv.push('-t', fileType);
    }
    argv.push('--', parsed.pattern, ...parsed.paths);

    return {
        pattern: parsed.pattern,
        paths: parsed.paths,
        requestedMaxResults,
        request: {
            executionId: '',
            argv,
            workingDirectory: parsed.workingDirectory ?? null,
            timeoutMs: DEFAULT_RIPGREP_TIMEOUT_MS,
        },
    };
}

/** rg --json 输出的单行 entry 结构（仅用到 type === 'match' 的部分）。 */
interface RipgrepJsonMatchEntry {
    type: string;
    data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start?: number }>;
    };
}

/**
 * 解析 rg --json 的 stdout，提取 type === 'match' 的条目。
 * 跳过非 match 条目和畸形 JSON 行（如二进制文件警告）。
 */
export function parseRipgrepJsonLines(stdout: string): RipgrepMatchRow[] {
    const rows: RipgrepMatchRow[] = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        if (!rawLine.trim()) {
            continue;
        }
        let entry: RipgrepJsonMatchEntry;
        try {
            entry = JSON.parse(rawLine) as RipgrepJsonMatchEntry;
        } catch {
            continue;
        }
        if (entry.type !== 'match') {
            continue;
        }
        const submatch = entry.data?.submatches?.[0];
        rows.push({
            path: entry.data?.path?.text ?? '[unknown path]',
            lineNumber: Number(entry.data?.line_number ?? 0),
            column: Number(submatch?.start ?? 0) + 1,
            lineText: String(entry.data?.lines?.text ?? '').trimEnd(),
        });
    }
    return rows;
}

/**
 * 格式化搜索结果为人类可读文本，包含 header（pattern/paths/engine/count）和编号列表。
 * rg 退出码 1 表示无匹配，此时返回 "No matches found." 而非错误。
 */
export function formatRipgrepResult(
    context: Pick<RipgrepRequestContext, 'pattern' | 'paths' | 'requestedMaxResults'>,
    response: Pick<BuiltInRipgrepExecutionResponse, 'binaryPath' | 'binarySource' | 'exitCode'>,
    matches: RipgrepMatchRow[]
): string {
    const header = [
        'Ripgrep search',
        `Pattern: ${context.pattern}`,
        `Paths: ${context.paths.join(', ')}`,
        `Engine: ${response.binarySource} (${response.binaryPath})`,
        `Returned: ${matches.length} matches (max ${context.requestedMaxResults})`,
    ];

    if (matches.length === 0 && response.exitCode === 1) {
        return [...header, '', 'No matches found.'].join('\n');
    }

    return [
        ...header,
        '',
        ...matches.map(
            (match, index) =>
                `${index + 1}. ${match.path}:${match.lineNumber}:${match.column}\n   ${match.lineText}`
        ),
    ].join('\n');
}
