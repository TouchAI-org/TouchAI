// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject } from '../../../contracts/protocol';
import type {
    ReasoningLevel,
    ReasoningMode,
    ReasoningProtocol,
} from '../../../contracts/reasoning';
import type { ReasoningNative } from './types';

/**
 * Reasoning 调试日志（R11）。
 *
 * 默认关闭，设置 `VITE_DEBUG_REASONING=1` 后开启。日志只包含档位/协议等
 * 非敏感信息，并在输出前对疑似密钥字段做脱敏。
 */
const DEBUG_ENABLED =
    typeof import.meta !== 'undefined' &&
    (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_DEBUG_REASONING === '1';

const SENSITIVE_KEY_PATTERN = /(key|token|secret|authorization|password)/i;

function redact(value: unknown, depth = 0): unknown {
    if (depth > 6 || value == null || typeof value !== 'object') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => redact(item, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redact(entry, depth + 1);
    }
    return result;
}

export interface ReasoningDebugEvent {
    protocol: ReasoningProtocol;
    mode: ReasoningMode;
    source: 'capability' | 'fallback' | 'off';
    requested: ReasoningLevel;
    native: ReasoningNative;
    modelId: string;
    hasTools: boolean;
    providerOptions?: Record<string, JsonObject>;
}

export function isReasoningDebugEnabled(): boolean {
    return DEBUG_ENABLED;
}

/** 出站 reasoning 参数、命中的 protocol / capability / native 档位。 */
export function logReasoningDebug(event: ReasoningDebugEvent): void {
    if (!DEBUG_ENABLED) {
        return;
    }

    console.debug('[reasoning] outbound', {
        modelId: event.modelId,
        protocol: event.protocol,
        mode: event.mode,
        source: event.source,
        requested: event.requested,
        native: event.native,
        hasTools: event.hasTools,
        providerOptions: redact(event.providerOptions),
    });
}

/** 入站是否收到 reasoning delta。 */
export function logReasoningDelta(event: {
    modelId: string;
    kind: 'start' | 'delta' | 'end';
    length?: number;
}): void {
    if (!DEBUG_ENABLED) {
        return;
    }

    console.debug('[reasoning] inbound', event);
}
