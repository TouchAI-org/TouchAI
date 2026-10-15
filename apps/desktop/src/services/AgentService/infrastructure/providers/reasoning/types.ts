// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JsonObject } from '../../../contracts/protocol';
import type {
    ModelThinkingLevel,
    ReasoningMode,
    ThinkingBudgets,
    ThinkingFormat,
    ThinkingLevelMap,
} from '../../../contracts/reasoning';

/**
 * 一次 reasoning 解析的完整结果。
 *
 * 与 Pi 的模型一致：resolver 只负责把统一档位 clamp 到模型支持的档位，并取出
 * `thinkingLevelMap` 里对应的原生字符串；具体怎么编码成请求参数交给 format 层。
 */
export interface ReasoningResolution {
    format: ThinkingFormat;
    mode: ReasoningMode;
    /** 请求层传入的档位（未传时为默认档位）。 */
    requested: ModelThinkingLevel;
    /** clamp 后实际使用的档位。 */
    level: ModelThinkingLevel;
    /** `thinkingLevelMap[level]` 命中的原生字符串（未命中为 undefined）。 */
    mapped: string | undefined;
    /** 模型完整的档位映射，format 层读取 `off` 等条目。 */
    map: ThinkingLevelMap;
    /** budget 形态模型计算出的思考预算；非 budget 模型为 undefined。 */
    budgetTokens: number | undefined;
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
    level: ModelThinkingLevel | undefined;
    /** 模型档位映射；空对象表示没有 metadata。 */
    map: ThinkingLevelMap;
    format: ThinkingFormat;
    mode: ReasoningMode;
    modelId: string;
    hasTools: boolean;
    /** budget 形态模型的原生 min/max，用于计算思考预算。 */
    budgetRange?: { min?: number; max?: number };
}

/** chat-template 系列里可由 Pi 控制的占位值。 */
export type ChatTemplateKwargValue =
    | string
    | number
    | boolean
    | null
    | { $var: 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean };

/**
 * 与 Pi 的 `compat` 对齐的思考相关兼容开关（provider 级或 model 级）。
 */
export interface ThinkingCompat {
    /** 是否发送 reasoning_effort / reasoning.effort；默认 true。 */
    supportsReasoningEffort?: boolean;
    /** 顶层思考预算字段名（vLLM / Qwen / llama.cpp）。 */
    thinkingTokenBudgetField?:
        | 'thinking_token_budget'
        | 'thinking_budget'
        | 'thinking_budget_tokens';
    /** `thinkingTokenBudgetField` 的别名（vLLM）。 */
    supportsThinkingTokenBudget?: boolean;
    /** `thinkingFormat: 'chat-template'` 的 chat_template_kwargs 模板。 */
    chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
    /** `thinkingFormat: 'baseten'` 的 chat_template_args 模板。 */
    chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;
    /** Anthropic 自适应思考（新模型用 effort，老模型用 budget）。 */
    forceAdaptiveThinking?: boolean;
    /** 档位对应的思考 token 预算覆盖。 */
    thinkingBudgets?: ThinkingBudgets;
}
