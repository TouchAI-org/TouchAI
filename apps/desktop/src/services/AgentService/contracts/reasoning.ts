// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * TouchAI 统一思考档位（Pi 风格）。
 *
 * 与 Pi 的 `ThinkingLevel` / `ModelThinkingLevel` 对齐：
 * - `ThinkingLevel`：模型可选的思考深度（minimal → max）。
 * - `ModelThinkingLevel`：在档位之外额外包含 `off`（关闭思考）。
 *
 * 请求层只传递统一档位；provider driver 通过 `thinkingLevelMap` 把档位翻译成
 * 厂商原生参数（reasoning_effort / thinking / reasoning.effort 等）。
 */

export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const MODEL_THINKING_LEVELS = ['off', ...THINKING_LEVELS] as const;

export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

/**
 * 未显式指定档位时的默认值：最高的统一档位。
 * 解析时会 clamp 到模型实际支持的最高档，因此等价于「尽可能深」。
 */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'max';

/**
 * 模型级档位映射（Pi 的 `thinkingLevelMap`）。
 *
 * 三态：
 * - 省略：`high` 及以下使用厂商默认映射；`xhigh` / `max` 视为不支持。
 * - string：支持该档位，并把该字符串发给厂商。
 * - null：不支持该档位，UI 隐藏 / clamp 时跳过。
 */
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

/**
 * 思考参数编码格式（Pi 的 `thinkingFormat`）。
 *
 * 前 11 项与 Pi 完全一致，作用于 OpenAI 兼容的 Chat Completions 请求体；
 * 后 3 项是 TouchAI 的传输层协议（Responses / Anthropic / Google），
 * 由 driver 按 provider 的 API 选择。
 */
export const THINKING_FORMATS = [
    'openai',
    'openrouter',
    'deepseek',
    'together',
    'baseten',
    'zai',
    'qwen',
    'qwen-chat-template',
    'chat-template',
    'string-thinking',
    'ant-ling',
    'openai-responses',
    'anthropic-messages',
    'google-generative',
] as const;

export type ThinkingFormat = (typeof THINKING_FORMATS)[number];

/**
 * 无 metadata 时的 fallback 行为（TouchAI 扩展，用于中转站）：
 * - auto：不发 reasoning 参数
 * - passthrough：强制透传统一档位
 * - off：完全不发 reasoning 参数
 */
export const REASONING_MODES = ['auto', 'passthrough', 'off'] as const;

export type ReasoningMode = (typeof REASONING_MODES)[number];

/** 思考 token 预算（Pi 的 `ThinkingBudgets`）。 */
export interface ThinkingBudgets {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
}

export const DEFAULT_THINKING_BUDGETS: Required<ThinkingBudgets> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
};

/** 思考预算必须给回答留出的最小空间（Pi 的 `MIN_ANSWER_TOKENS`）。 */
export const MIN_ANSWER_TOKENS = 1024;

const thinkingLevelSet = new Set<string>(THINKING_LEVELS);
const modelThinkingLevelSet = new Set<string>(MODEL_THINKING_LEVELS);
const thinkingFormatSet = new Set<string>(THINKING_FORMATS);
const reasoningModeSet = new Set<string>(REASONING_MODES);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === 'string' && thinkingLevelSet.has(value);
}

export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
    return typeof value === 'string' && modelThinkingLevelSet.has(value);
}

export function isThinkingFormat(value: unknown): value is ThinkingFormat {
    return typeof value === 'string' && thinkingFormatSet.has(value);
}

export function isReasoningMode(value: unknown): value is ReasoningMode {
    return typeof value === 'string' && reasoningModeSet.has(value);
}

/**
 * 上游模型 metadata 声明的 reasoning 能力。
 *
 * 与 models.dev 的 `reasoning_options` 保持一致，覆盖三种形态：
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
 * 把上游 capability 归一化成 Pi 的 `thinkingLevelMap`。
 *
 * - effort：命中的档位映射为自身；`none` / `off` 映射到 `off`；枚举里没有关闭档位时 `off` 为 null。
 * - toggle：只有开关，所有档位映射为自身，`off` 省略（默认支持关闭）。
 * - budget_tokens：所有档位映射为自身，具体预算由 `thinkingBudgetForLevel` 计算。
 */
export function deriveThinkingLevelMap(
    options: ReasoningOption[] | null | undefined
): ThinkingLevelMap {
    const map: ThinkingLevelMap = {};
    if (!options || options.length === 0) {
        return map;
    }

    const effort = options.find(
        (option): option is Extract<ReasoningOption, { type: 'effort' }> => option.type === 'effort'
    );
    const toggle = options.find(
        (option): option is Extract<ReasoningOption, { type: 'toggle' }> => option.type === 'toggle'
    );
    const budget = options.find(
        (option): option is Extract<ReasoningOption, { type: 'budget_tokens' }> =>
            option.type === 'budget_tokens'
    );

    if (effort) {
        const values = new Set(effort.values);
        // effort 枚举是穷尽的：没有 none/off 即表示该模型无法关闭思考（对齐 Pi 的 catalog）。
        map.off = values.has('none') ? 'none' : values.has('off') ? 'off' : null;
        for (const level of THINKING_LEVELS) {
            map[level] = values.has(level) ? level : null;
        }
        return map;
    }

    if (toggle || budget) {
        for (const level of THINKING_LEVELS) {
            map[level] = level;
        }
        return map;
    }

    return map;
}

/**
 * 模型支持的档位（Pi 的 `getSupportedThinkingLevels`）。
 *
 * - 不支持 reasoning：只有 `off`。
 * - 映射为 null：不支持，跳过。
 * - `xhigh` / `max` 必须显式映射，否则视为不支持。
 */
export function getSupportedThinkingLevels(
    map: ThinkingLevelMap | null | undefined,
    reasoning = true
): ModelThinkingLevel[] {
    if (!reasoning) {
        return ['off'];
    }

    return MODEL_THINKING_LEVELS.filter((level) => {
        const mapped = map?.[level];
        if (mapped === null) {
            return false;
        }
        if (level === 'xhigh' || level === 'max') {
            return mapped !== undefined;
        }
        return true;
    });
}

/**
 * 把请求档位 clamp 到模型支持的档位（Pi 的 `clampThinkingLevel`）。
 *
 * 命中直接返回；否则先向更高档找，再向更低档找；兜底最低档。
 */
export function clampThinkingLevel(
    map: ThinkingLevelMap | null | undefined,
    level: ModelThinkingLevel
): ModelThinkingLevel {
    const available = getSupportedThinkingLevels(map, true);
    if (available.includes(level)) {
        return level;
    }

    const requestedIndex = MODEL_THINKING_LEVELS.indexOf(level);
    if (requestedIndex === -1) {
        return available[0] ?? 'off';
    }

    for (let i = requestedIndex; i < MODEL_THINKING_LEVELS.length; i++) {
        const candidate = MODEL_THINKING_LEVELS[i];
        if (candidate !== undefined && available.includes(candidate)) {
            return candidate;
        }
    }

    for (let i = requestedIndex - 1; i >= 0; i--) {
        const candidate = MODEL_THINKING_LEVELS[i];
        if (candidate !== undefined && available.includes(candidate)) {
            return candidate;
        }
    }

    return available[0] ?? 'off';
}

/** 档位对应的思考 token 预算（Pi 的 `thinkingBudgetForLevel`）。 */
export function thinkingBudgetForLevel(
    level: ModelThinkingLevel,
    budgets?: ThinkingBudgets
): number | undefined {
    if (level === 'off') {
        return 0;
    }

    const merged = { ...DEFAULT_THINKING_BUDGETS, ...budgets };
    if (level === 'xhigh' || level === 'max') {
        return merged.high;
    }
    return merged[level];
}

/** 思考预算必须给回答留出 `MIN_ANSWER_TOKENS` 空间（Pi 的同名工具）。 */
export function clampThinkingBudgetToAnswerRoom(budget: number, ceiling?: number): number {
    if (ceiling === undefined || !Number.isFinite(ceiling)) {
        return budget;
    }
    return Math.min(budget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}
