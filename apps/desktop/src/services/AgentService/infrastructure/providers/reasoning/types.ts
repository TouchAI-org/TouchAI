// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject } from '../../../contracts/protocol';
import type {
    ReasoningLevel,
    ReasoningMode,
    ReasoningOption,
    ReasoningProtocol,
} from '../../../contracts/reasoning';

/**
 * 统一档位解析后得到的 provider 原生档位。
 *
 * 与 opencode 的 variant settings 等价：resolver 只负责挑选最接近的原生档位，
 * 具体怎么编码成请求参数交给 protocol 层。
 */
export type ReasoningNative =
    | { kind: 'effort'; effort: string }
    | { kind: 'toggle'; enabled: boolean }
    | { kind: 'budget'; tokens: number }
    | { kind: 'none' };

/** 一次 reasoning 解析的完整结果，用于日志与协议编码。 */
export interface ReasoningPlan {
    protocol: ReasoningProtocol;
    mode: ReasoningMode;
    requested: ReasoningLevel;
    native: ReasoningNative;
    /** capability=命中 metadata；fallback=无 metadata 的兜底；off=显式关闭。 */
    source: 'capability' | 'fallback' | 'off';
    hasTools: boolean;
    modelId: string;
}

export interface ReasoningEncoderResult {
    providerOptions?: Record<string, JsonObject>;
    body?: JsonObject;
    headers?: Record<string, string>;
}

export interface ResolveReasoningInput {
    level: ReasoningLevel | undefined;
    capability: ReasoningOption[];
    protocol: ReasoningProtocol;
    mode: ReasoningMode;
    modelId: string;
    hasTools: boolean;
}
