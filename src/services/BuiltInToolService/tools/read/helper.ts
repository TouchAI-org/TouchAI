// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    basename,
    desktopDir,
    dirname,
    isAbsolute,
    resolve as resolvePath,
} from '@tauri-apps/api/path';
import { type DirEntry, open, readDir, readTextFileLines, stat } from '@tauri-apps/plugin-fs';

import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';
import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import { createAttachment } from '@/services/AgentService/infrastructure/attachments';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import type { BaseBuiltInToolExecutionContext, BuiltInToolConversationSemantic } from '../../types';
import { parseToolArguments, z } from '../../utils/toolSchema';
import {
    DEFAULT_READ_LIMIT,
    DEFAULT_READ_OFFSET,
    MAX_BINARY_SNIFF_BYTES,
    MAX_LINE_LENGTH,
    MAX_READ_BYTES,
    MAX_READ_BYTES_LABEL,
    MAX_SUGGESTIONS,
    rasterImageExtensions,
    READ_TOOL_NAME,
    readArgsSchema,
} from './constants';

type ReadToolArgs = z.infer<typeof readArgsSchema>;
type ReadTargetKind = 'directory' | 'image' | 'pdf' | 'file';

const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;

function getPathLeaf(input: string): string {
    const normalized = input.trim().replace(/[\\/]+$/, '');
    const segments = normalized.split(/[\\/]+/);
    return segments[segments.length - 1] || normalized;
}

function getPathExtension(input: string): string {
    const leaf = getPathLeaf(input);
    const dotIndex = leaf.lastIndexOf('.');
    return dotIndex >= 0
        ? leaf
              .slice(dotIndex + 1)
              .trim()
              .toLowerCase()
        : '';
}

function formatDirectoryEntry(entry: DirEntry): string {
    if (entry.isDirectory) {
        return `${entry.name}/`;
    }

    if (entry.isSymlink) {
        return `${entry.name}@`;
    }

    return entry.name;
}

function truncateLine(text: string): string {
    return text.length > MAX_LINE_LENGTH
        ? `${text.slice(0, MAX_LINE_LENGTH)}${MAX_LINE_SUFFIX}`
        : text;
}

function resolveMediaKind(path: string): Exclude<ReadTargetKind, 'directory' | 'file'> | null {
    const extension = getPathExtension(path);
    if (extension === 'pdf') {
        return 'pdf';
    }

    if (rasterImageExtensions.has(extension)) {
        return 'image';
    }

    return null;
}

async function resolveReadPath(filePath: string): Promise<string> {
    const trimmed = filePath.trim();
    if (await isAbsolute(trimmed)) {
        return trimmed;
    }

    const desktopPath = await desktopDir();
    return resolvePath(desktopPath, trimmed);
}

async function createMissingPathMessage(path: string): Promise<string> {
    try {
        const [parentPath, fileName] = await Promise.all([dirname(path), basename(path)]);
        const entries = await readDir(parentPath);
        const suggestions = entries
            .map((entry) => entry.name)
            .filter((name) => {
                const lowerName = name.toLowerCase();
                const lowerTarget = fileName.toLowerCase();
                return lowerName.includes(lowerTarget) || lowerTarget.includes(lowerName);
            })
            .sort((left, right) => left.localeCompare(right))
            .slice(0, MAX_SUGGESTIONS);

        if (suggestions.length === 0) {
            return `File not found: ${path}`;
        }

        return [`File not found: ${path}`, '', 'Did you mean one of these?', ...suggestions].join(
            '\n'
        );
    } catch {
        return `File not found: ${path}`;
    }
}

async function sniffBinaryFile(path: string, fileSize: number): Promise<boolean> {
    if (fileSize === 0) {
        return false;
    }

    const file = await open(path, { read: true });
    try {
        const sampleSize = Math.min(fileSize, MAX_BINARY_SNIFF_BYTES);
        const buffer = new Uint8Array(sampleSize);
        const bytesRead = await file.read(buffer);
        if (!bytesRead) {
            return false;
        }

        let nonPrintableCount = 0;
        for (let index = 0; index < bytesRead; index += 1) {
            const value = buffer[index]!;
            if (value === 0) {
                return true;
            }

            if (value < 9 || (value > 13 && value < 32)) {
                nonPrintableCount += 1;
            }
        }

        return nonPrintableCount / bytesRead > 0.3;
    } finally {
        await file.close();
    }
}

async function readDirectoryContent(path: string, args: ReadToolArgs): Promise<string> {
    const entries = (await readDir(path)).map((entry) => formatDirectoryEntry(entry));
    entries.sort((left, right) => left.localeCompare(right));

    const offset = args.offset ?? DEFAULT_READ_OFFSET;
    const limit = args.limit ?? DEFAULT_READ_LIMIT;
    const startIndex = offset - 1;
    const sliced = entries.slice(startIndex, startIndex + limit);
    const truncated = startIndex + sliced.length < entries.length;

    return [
        `<path>${path}</path>`,
        '<type>directory</type>',
        '<entries>',
        ...sliced,
        truncated
            ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use offset=${offset + sliced.length} to continue.)`
            : `\n(${entries.length} entries)`,
        '</entries>',
    ].join('\n');
}

async function readTextWindow(
    path: string,
    args: ReadToolArgs,
    signal?: AbortSignal
): Promise<{
    offset: number;
    raw: string[];
    count: number;
    more: boolean;
    cut: boolean;
}> {
    const offset = args.offset ?? DEFAULT_READ_OFFSET;
    const limit = args.limit ?? DEFAULT_READ_LIMIT;
    const startIndex = offset - 1;
    const encoder = new TextEncoder();
    const iterator = await readTextFileLines(path);

    const raw: string[] = [];
    let count = 0;
    let more = false;
    let cut = false;
    let bytes = 0;

    for await (const originalLine of iterator) {
        if (signal?.aborted) {
            throw new Error('Request cancelled');
        }

        count += 1;
        if (count <= startIndex) {
            continue;
        }

        if (raw.length >= limit) {
            more = true;
            continue;
        }

        const line = truncateLine(originalLine);
        const nextSize = encoder.encode(line).length + (raw.length > 0 ? 1 : 0);
        if (bytes + nextSize > MAX_READ_BYTES) {
            cut = true;
            more = true;
            break;
        }

        raw.push(line);
        bytes += nextSize;
    }

    return { offset, raw, count, more, cut };
}

function formatTextReadResult(
    path: string,
    window: Awaited<ReturnType<typeof readTextWindow>>
): string {
    if (window.count < window.offset && !(window.count === 0 && window.offset === 1)) {
        throw new Error(
            `Offset ${window.offset} is out of range for this file (${window.count} lines)`
        );
    }

    let output = [`<path>${path}</path>`, '<type>file</type>', '<content>'].join('\n');
    if (window.raw.length > 0) {
        output += `\n${window.raw
            .map((line, index) => `${window.offset + index}: ${line}`)
            .join('\n')}`;
    }

    const lastLine = window.offset + window.raw.length - 1;
    const nextOffset = lastLine + 1;

    if (window.cut) {
        output += `\n\n(Output capped at ${MAX_READ_BYTES_LABEL}. Showing lines ${window.offset}-${lastLine}. Use offset=${nextOffset} to continue.)`;
    } else if (window.more) {
        output += `\n\n(Showing lines ${window.offset}-${lastLine} of ${window.count}. Use offset=${nextOffset} to continue.)`;
    } else {
        output += `\n\n(End of file - total ${window.count} lines)`;
    }

    output += '\n</content>';
    return output;
}

async function buildMediaReadResult(
    path: string,
    kind: 'image' | 'pdf'
): Promise<{ result: string; attachments: AttachmentIndex[] }> {
    const attachment = await createAttachment(kind === 'image' ? 'image' : 'file', path);
    const label = kind === 'image' ? 'image' : 'pdf';

    return {
        result: [
            `<path>${path}</path>`,
            `<type>${label}</type>`,
            '<content>',
            `${kind === 'image' ? 'Image' : 'PDF'} attached in tool result.`,
            '</content>',
        ].join('\n'),
        attachments: [attachment],
    };
}

export function buildReadConversationSemantic(
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    const rawPath = normalizeOptionalString(args.filePath, { collapseWhitespace: true });
    return {
        action: 'read',
        target: rawPath ? truncateText(getPathLeaf(rawPath), 120) : '本地文件',
    };
}

/**
 * 构建 Read 工具审批请求。
 * 读取本地文件/目录会把路径和内容暴露给模型，因此默认需要用户显式批准。
 */
export async function buildReadApprovalRequest(
    args: Record<string, unknown>
): Promise<ToolApprovalRequest | null> {
    let parsedArgs: ReadToolArgs;
    try {
        parsedArgs = parseToolArguments(READ_TOOL_NAME, readArgsSchema, args);
    } catch {
        return null;
    }

    const resolvedPath = await resolveReadPath(parsedArgs.filePath);
    return {
        title: '读取本地内容确认',
        description: '',
        command: resolvedPath,
        riskLabel: '',
        reason: '此操作会读取本地文件或目录内容，并将结果发送给模型。',
        commandLabel: '',
        approveLabel: '批准',
        rejectLabel: '拒绝',
        enterHint: 'Enter',
        escHint: 'Esc',
        keyboardApproveDelayMs: 450,
    };
}

export async function executeReadFile(
    args: Record<string, unknown>,
    context: BaseBuiltInToolExecutionContext
): Promise<{
    result: string;
    attachments?: AttachmentIndex[];
}> {
    const parsedArgs = parseToolArguments(READ_TOOL_NAME, readArgsSchema, args);
    const path = await resolveReadPath(parsedArgs.filePath);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
        info = await stat(path);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.toLowerCase().includes('not found')) {
            throw new Error(await createMissingPathMessage(path));
        }

        throw error;
    }

    let kind: ReadTargetKind = info.isDirectory ? 'directory' : 'file';
    if (!info.isDirectory) {
        kind = resolveMediaKind(path) ?? 'file';
    }

    if (kind === 'directory') {
        return {
            result: await readDirectoryContent(path, parsedArgs),
        };
    }

    if (kind === 'image' || kind === 'pdf') {
        return buildMediaReadResult(path, kind);
    }

    const isBinary = await sniffBinaryFile(path, info.size);
    if (isBinary) {
        throw new Error(`Cannot read binary file: ${path}`);
    }

    return {
        result: formatTextReadResult(path, await readTextWindow(path, parsedArgs, context.signal)),
    };
}
