// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { McpToolCallResponse } from '@services/NativeService';

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
                return `[Image: ${item.mime_type}]`;
            } else if (item.type === 'resource') {
                return item.text || `[Resource: ${item.uri}]`;
            }
            return '';
        })
        .join('\n');
}

/**
 * 让 promise 与超时和可选的 AbortSignal 竞争
 */
export function raceWithTimeoutAndSignal<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<T> {
    // 快速路径：没有超时且没有有效信号，直接返回原始 promise
    if (timeoutMs <= 0 && (!signal || signal.aborted)) {
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
        const onAbort = () => settle(reject, new Error('Request cancelled'));

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

        // 超时竞争者：如果工具执行时间过长则拒绝
        if (timeoutMs > 0) {
            timer = setTimeout(
                () => settle(reject, new Error(`Tool execution timed out after ${timeoutMs}ms`)),
                timeoutMs
            );
        }

        // 中止信号竞争者：如果用户取消请求则拒绝
        if (signal && !signal.aborted) {
            signal.addEventListener('abort', onAbort, { once: true });
        } else if (signal?.aborted) {
            settle(reject, new Error('Request cancelled'));
        }
    });
}
