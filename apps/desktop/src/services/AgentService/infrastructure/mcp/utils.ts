// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { McpToolCallResponse } from '@services/NativeService';

import { t } from '@/i18n';
import {
    type AttachmentIndex,
    base64ToUint8Array,
    createPersistedAttachmentFromData,
} from '@/services/AgentService/infrastructure/attachments';
import { parseMcpServerArgsJson, parseMcpServerRecordJson } from '@/utils/mcpSchemas';

export function readOptionalMcpArgs(argsJson?: string | null): string[] | undefined {
    const args = parseMcpServerArgsJson(argsJson);
    return args.length > 0 ? args : undefined;
}

export function readOptionalMcpRecord(
    recordJson?: string | null
): Record<string, string> | undefined {
    const record = parseMcpServerRecordJson(recordJson);
    return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * 将错误消息标准化为一致的字符串格式
 * 处理 Error 对象和原始错误值，确保始终有可显示的错误消息
 */
export function normalizeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 将 MCP 响应转换为 AI 服务期望的格式
 */
export function formatMcpToolResponse(response: McpToolCallResponse): string {
    return response.content
        .map((item) => {
            if (item.type === 'text') {
                return item.text || '';
            } else if (item.type === 'image') {
                return t('agent.mcp.imageResult', { mimeType: item.mime_type ?? 'unknown' });
            } else if (item.type === 'resource') {
                return item.text || t('agent.mcp.resourceResult', { uri: item.uri ?? 'unknown' });
            }
            return '';
        })
        .join('\n');
}

const mimeTypeExtensionMap: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
};

const extensionMimeTypeMap: Record<string, string> = Object.fromEntries(
    Object.entries(mimeTypeExtensionMap).map(([mimeType, extension]) => [extension, mimeType])
);

function inferMimeTypeFromUri(uri?: string): string | undefined {
    if (!uri) {
        return undefined;
    }

    try {
        const parsed = new URL(uri);
        const filename = parsed.pathname.split('/').pop() ?? '';
        const extension = filename.split('.').pop()?.trim().toLowerCase();
        return extension ? extensionMimeTypeMap[extension] : undefined;
    } catch {
        const filename = uri.split('/').pop() ?? '';
        const extension = filename.split('.').pop()?.trim().toLowerCase();
        return extension ? extensionMimeTypeMap[extension] : undefined;
    }
}

function resolveAttachmentName(options: {
    uri?: string;
    mimeType?: string;
    fallbackBaseName: string;
}): string {
    if (options.uri) {
        try {
            const parsed = new URL(options.uri);
            const filename = parsed.pathname.split('/').pop();
            if (filename) {
                return filename;
            }
        } catch {
            const filename = options.uri.split('/').pop();
            if (filename) {
                return filename;
            }
        }
    }

    const extension = options.mimeType ? mimeTypeExtensionMap[options.mimeType] : undefined;
    return extension ? `${options.fallbackBaseName}.${extension}` : options.fallbackBaseName;
}

function resolveSyntheticOriginPath(options: {
    toolCallId: string;
    toolName: string;
    index: number;
    type: 'image' | 'file';
}): string {
    return `mcp://tool-result/${options.toolName}/${options.toolCallId}/${options.type}-${options.index + 1}`;
}

function resolveAttachmentDescriptor(
    response: McpToolCallResponse,
    context: {
        toolCallId: string;
        toolName: string;
    }
): Array<{
    type: 'image' | 'file';
    name: string;
    originPath: string;
    mimeType?: string;
    data: Uint8Array;
}> {
    const attachments: Array<{
        type: 'image' | 'file';
        name: string;
        originPath: string;
        mimeType?: string;
        data: Uint8Array;
    }> = [];

    response.content.forEach((item, index) => {
        if (item.type === 'image' && item.data) {
            attachments.push({
                type: 'image',
                name: resolveAttachmentName({
                    mimeType: item.mime_type,
                    fallbackBaseName: `tool-image-${index + 1}`,
                }),
                originPath: resolveSyntheticOriginPath({
                    toolCallId: context.toolCallId,
                    toolName: context.toolName,
                    index,
                    type: 'image',
                }),
                mimeType: item.mime_type,
                data: base64ToUint8Array(item.data),
            });
            return;
        }

        if (item.type !== 'resource' || !item.blob) {
            return;
        }

        const mimeType = item.mime_type ?? inferMimeTypeFromUri(item.uri);
        const name = resolveAttachmentName({
            uri: item.uri,
            mimeType,
            fallbackBaseName: `tool-file-${index + 1}`,
        });
        const type = mimeType?.startsWith('image/') ? 'image' : 'file';
        attachments.push({
            type,
            name,
            originPath:
                item.uri ||
                resolveSyntheticOriginPath({
                    toolCallId: context.toolCallId,
                    toolName: context.toolName,
                    index,
                    type,
                }),
            mimeType,
            data: base64ToUint8Array(item.blob),
        });
    });

    return attachments;
}

export async function extractMcpToolAttachments(
    response: McpToolCallResponse,
    context: {
        toolCallId: string;
        toolName: string;
    }
): Promise<AttachmentIndex[]> {
    const descriptors = resolveAttachmentDescriptor(response, context);
    return Promise.all(
        descriptors.map((descriptor) =>
            createPersistedAttachmentFromData({
                type: descriptor.type,
                name: descriptor.name,
                originPath: descriptor.originPath,
                mimeType: descriptor.mimeType,
                size: descriptor.data.byteLength,
                data: descriptor.data,
            })
        )
    );
}

/**
 * 原生超时到期与本地守卫之间的宽限窗口（毫秒）。
 *
 * 有效超时会同时下发给原生层和本地竞争：原生层负责在到点时向远端发送取消通知，
 * 本地竞争只是兜底守卫。Tauri IPC 与原生调度会让两侧的到期时刻相差几毫秒，
 * 若两侧使用同一个截止点，本地守卫会先于原生取消触发，使调用方在远端尚未收到
 * 取消时就看到超时。这里给本地守卫留出宽限窗口，让原生层先到期。
 */
export const MCP_TIMEOUT_GUARD_GRACE_MS = 1000;

/**
 * `setTimeout` 能表达的最大延迟（毫秒，2^31 - 1）。
 *
 * 超出该范围的延迟会溢出并几乎立刻触发，把一个“很久以后才超时”的配置
 * 变成“马上超时”。这类配置只能交给原生超时与取消信号处理。
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * 让 promise 与超时和可选的 AbortSignal 竞争
 *
 * `timeoutMs` 是本地守卫的截止点；`reportedTimeoutMs` 是超时错误里展示的值，
 * 默认与截止点一致。MCP 调用会在守卫截止点上叠加宽限窗口，此时仍应展示
 * 真正下发给原生的有效超时。
 */
export function raceWithTimeoutAndSignal<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
    reportedTimeoutMs: number = timeoutMs
): Promise<T> {
    if (signal?.aborted) {
        return Promise.reject(new Error(t('agent.mcp.requestCancelled')));
    }

    // 快速路径：没有超时且没有有效信号，直接返回原始 promise
    if (timeoutMs <= 0 && !signal) {
        return promise;
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;

        // 确保只有第一个完成者获胜，且清理只发生一次
        const settle = (fn: typeof resolve | typeof reject, value: T | Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            (fn as (v: T | Error) => void)(value);
        };

        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => settle(reject, new Error(t('agent.mcp.requestCancelled')));

        // 清理所有竞争资源：定时器和中止监听器
        const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };

        // 主 promise 竞争者
        promise.then(
            (value) => settle(resolve, value),
            (error) => settle(reject, error)
        );

        // 超时竞争者：如果工具执行时间过长则拒绝。
        // 超出 setTimeout 表达范围的截止点不设计时器，否则会立刻触发。
        if (timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS) {
            timer = setTimeout(
                () =>
                    settle(
                        reject,
                        new Error(t('agent.mcp.toolTimeout', { timeoutMs: reportedTimeoutMs }))
                    ),
                timeoutMs
            );
        }

        // 中止信号竞争者：如果用户取消请求则拒绝
        if (signal && !signal.aborted) {
            signal.addEventListener('abort', onAbort, { once: true });
        } else if (signal?.aborted) {
            settle(reject, new Error(t('agent.mcp.requestCancelled')));
        }
    });
}

/**
 * Rust 侧 MCP 超时的稳定文案，见 `core::mcp::client::format_call_error`。
 * 原生层已经发过取消通知，这里只负责把它翻译成用户可见的本地化文案。
 */
const NATIVE_MCP_TIMEOUT_PATTERN = /^Tool execution timed out \((\d+)ms\)$/;

export function localizeNativeMcpTimeoutError(error: unknown, timeoutMs: number): Error {
    const message = normalizeErrorMessage(error);
    if (NATIVE_MCP_TIMEOUT_PATTERN.test(message)) {
        return new Error(t('agent.mcp.toolTimeout', { timeoutMs }));
    }

    return error instanceof Error ? error : new Error(message);
}
