// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * TouchAI 统一思考档位。
 *
 * 请求层只传递这里定义的档位；具体供应商在各自 provider driver 中把它
 * 翻译成自己的 reasoning effort / thinking 参数。
 */
export const REASONING_LEVELS = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'max';

const reasoningLevelSet = new Set<string>(REASONING_LEVELS);

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
    return typeof value === 'string' && reasoningLevelSet.has(value);
}

/**
 * 上游模型 metadata 声明的 reasoning 能力。
 *
 * 与 opencode 的 `Support` 保持一致，覆盖三种形态：
 * - `effort`：枚举档位（如 none/low/medium/high/xhigh）
 * - `toggle`：只有开/关，没有细分档位
 * - `budget_tokens`：以 token 预算表达，可带 min/max
 */
export type ReasoningOption =
    | { type: 'effort'; values: string[] }
    | { type: 'toggle' }
    | { type: 'budget_tokens'; min?: number; max?: number };

function normalizeReasoningOption(value: unknown): ReasoningOption | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const type = record.type;

    if (type === 'toggle') {
        return { type: 'toggle' };
    }

    if (type === 'effort') {
        const rawValues = Array.isArray(record.values) ? record.values : [];
        const values = rawValues.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0
        );
        if (values.length === 0) {
            return null;
        }
        return { type: 'effort', values };
    }

    if (type === 'budget_tokens') {
        const option: ReasoningOption = { type: 'budget_tokens' };
        if (typeof record.min === 'number' && Number.isFinite(record.min)) {
            option.min = record.min;
        }
        if (typeof record.max === 'number' && Number.isFinite(record.max)) {
            option.max = record.max;
        }
        return option;
    }

    return null;
}

/**
 * 把上游 metadata 的 reasoning_options 归一化成数组。
 *
 * 上游既可能是单个对象，也可能是对象数组，还可能混入 null / 空值；
 * 这里统一清洗成 `ReasoningOption[]`，无效项直接丢弃。
 */
export function normalizeReasoningOptions(raw: unknown): ReasoningOption[] {
    if (raw == null) {
        return [];
    }

    const candidates = Array.isArray(raw) ? raw : [raw];
    const options: ReasoningOption[] = [];
    for (const candidate of candidates) {
        const option = normalizeReasoningOption(candidate);
        if (option) {
            options.push(option);
        }
    }

    return options;
}

/** 序列化为数据库 JSON 列；无有效能力时返回 null。 */
export function serializeReasoningOptions(
    options: ReasoningOption[] | null | undefined
): string | null {
    if (!options || options.length === 0) {
        return null;
    }
    return JSON.stringify(options);
}

/** 从数据库 JSON 列解析；解析失败或为空时返回空数组。 */
export function parseReasoningOptions(json: string | null | undefined): ReasoningOption[] {
    if (!json) {
        return [];
    }

    try {
        return normalizeReasoningOptions(JSON.parse(json));
    } catch {
        return [];
    }
}

/** 是否声明了任意 reasoning 能力。 */
export function hasReasoningCapability(options: ReasoningOption[] | null | undefined): boolean {
    return Array.isArray(options) && options.length > 0;
}
/**
 * 协议编码器标识。按协议而非 provider 名实现，允许中转站显式指定。
 */
export const REASONING_PROTOCOLS = [
    'openai-chat',
    'openai-responses',
    'deepseek-chat',
    'anthropic-messages',
    'google-generative',
    'openai-compatible',
] as const;

export type ReasoningProtocol = (typeof REASONING_PROTOCOLS)[number];

/**
 * 无 metadata 时的 fallback 行为：
 * - auto：不发 reasoning 参数
 * - passthrough：强制透传统一档位
 * - off：完全不发 reasoning 参数
 */
export const REASONING_MODES = ['auto', 'passthrough', 'off'] as const;

export type ReasoningMode = (typeof REASONING_MODES)[number];

const reasoningProtocolSet = new Set<string>(REASONING_PROTOCOLS);
const reasoningModeSet = new Set<string>(REASONING_MODES);

export function isReasoningProtocol(value: unknown): value is ReasoningProtocol {
    return typeof value === 'string' && reasoningProtocolSet.has(value);
}

export function isReasoningMode(value: unknown): value is ReasoningMode {
    return typeof value === 'string' && reasoningModeSet.has(value);
}
