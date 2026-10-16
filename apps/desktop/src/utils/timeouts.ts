// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 工具调用超时元数据的保留键。
 *
 * 模型通过工具参数里的这个对象建议单次调用的超时，例如
 * `{ "_meta": { "timeoutMs": 60000 } }`。执行器会在真正执行前
 * 把它从业务参数中剥离，因此工具本身永远看不到 `_meta`。
 */
export const TOOL_TIMEOUT_META_KEY = '_meta';

/**
 * 模型可建议的工具调用超时边界（毫秒）。
 *
 * 这是“模型建议超时”的默认区间：schema 描述、schema 的
 * minimum / maximum 以及执行期收敛都引用这组常量，避免多处硬编码
 * 后互相漂移。单个工具可以声明更小的上限（例如 Bash 受 Rust 侧
 * `built_in_tools::bash` 的硬上限约束），此时以该工具的声明为准。
 */
export const TOOL_TIMEOUT_MIN_MS = 1000;
export const TOOL_TIMEOUT_MAX_MS = 600000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从工具参数中解析模型建议的超时，并返回剥离 `_meta` 后的业务参数。
 *
 * 只负责“形状与类型”校验：`_meta.timeoutMs` 必须是整数才会被采用，
 * 越界值交由 {@link clampTimeoutMs} 收敛。未提供 `_meta` 时原样返回入参，
 * 避免无谓的复制。
 */
export function parseRequestedTimeoutMs(toolArgs: Record<string, unknown>): {
    requestedTimeoutMs?: number;
    sanitizedToolArgs: Record<string, unknown>;
} {
    if (!(TOOL_TIMEOUT_META_KEY in toolArgs)) {
        return { requestedTimeoutMs: undefined, sanitizedToolArgs: toolArgs };
    }

    const sanitizedToolArgs = { ...toolArgs };
    const meta = sanitizedToolArgs[TOOL_TIMEOUT_META_KEY];
    delete sanitizedToolArgs[TOOL_TIMEOUT_META_KEY];

    if (!isRecord(meta)) {
        return { requestedTimeoutMs: undefined, sanitizedToolArgs };
    }

    const timeoutMs = meta.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) {
        return { requestedTimeoutMs: undefined, sanitizedToolArgs };
    }

    return { requestedTimeoutMs: timeoutMs, sanitizedToolArgs };
}

/**
 * 把模型建议的超时收敛到 `[TOOL_TIMEOUT_MIN_MS, max]`；缺省或非法时回退到 `fallback`。
 *
 * 入参应为有限整数（{@link parseRequestedTimeoutMs} 已保证），这里只做区间收敛。
 * `max` 允许调用方传入工具自己的封顶值（默认取共享上限）。
 */
export function clampTimeoutMs(
    requested: number | undefined | null,
    fallback: number,
    max: number = TOOL_TIMEOUT_MAX_MS
): number {
    if (typeof requested !== 'number' || !Number.isInteger(requested)) {
        return fallback;
    }

    return Math.min(Math.max(requested, TOOL_TIMEOUT_MIN_MS), max);
}
