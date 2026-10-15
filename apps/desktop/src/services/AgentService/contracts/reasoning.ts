// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * TouchAI 统一思考档位。
 *
 * - `ReasoningLevel`：模型可选的思考深度（minimal → max）。
 * - `SelectableReasoningLevel`：在档位之外额外包含 `off`（关闭思考）。
 *
 * 请求层只传递统一档位；provider driver 通过 `reasoningLevelMap` 把档位翻译成
 * 厂商原生参数（reasoning_effort / thinking / reasoning.effort 等）。
 */

export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const SELECTABLE_REASONING_LEVELS = ['off', ...REASONING_LEVELS] as const;

export type SelectableReasoningLevel = (typeof SELECTABLE_REASONING_LEVELS)[number];

/** 未显式指定档位时的默认值，解析时会 clamp 到模型实际支持的最高档。 */
export const DEFAULT_REASONING_LEVEL: SelectableReasoningLevel = 'max';

/**
 * 模型级档位映射。
 *
 * 三态：
 * - 省略：`high` 及以下使用厂商默认映射；`xhigh` / `max` 视为不支持。
 * - string：支持该档位，并把该字符串发给厂商。
 * - null：不支持该档位，UI 隐藏 / clamp 时跳过。
 */
export type ReasoningLevelMap = Partial<Record<SelectableReasoningLevel, string | null>>;

/** 思考参数编码协议，由 driver 按 provider 的 API 选择。 */
export const REASONING_PROTOCOLS = [
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

export type ReasoningProtocol = (typeof REASONING_PROTOCOLS)[number];

/**
 * 无 metadata 时的 fallback 行为（TouchAI 扩展，用于中转站）：
 * - auto：不发 reasoning 参数
 * - passthrough：强制透传统一档位
 * - off：完全不发 reasoning 参数
 */
export const REASONING_MODES = ['auto', 'passthrough', 'off'] as const;

export type ReasoningMode = (typeof REASONING_MODES)[number];

/** 思考 token 预算。 */
export interface ReasoningTokenBudgets {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
}

export const DEFAULT_REASONING_TOKEN_BUDGETS: Required<ReasoningTokenBudgets> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
};

/** 思考预算必须给回答留出的最小空间。 */
export const MIN_RESPONSE_TOKENS = 1024;

const reasoningLevelSet = new Set<string>(REASONING_LEVELS);
const selectableReasoningLevelSet = new Set<string>(SELECTABLE_REASONING_LEVELS);
const reasoningProtocolSet = new Set<string>(REASONING_PROTOCOLS);
const reasoningModeSet = new Set<string>(REASONING_MODES);

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
    return typeof value === 'string' && reasoningLevelSet.has(value);
}

export function isSelectableReasoningLevel(value: unknown): value is SelectableReasoningLevel {
    return typeof value === 'string' && selectableReasoningLevelSet.has(value);
}

export function isReasoningProtocol(value: unknown): value is ReasoningProtocol {
    return typeof value === 'string' && reasoningProtocolSet.has(value);
}

export function isReasoningMode(value: unknown): value is ReasoningMode {
    return typeof value === 'string' && reasoningModeSet.has(value);
}

/** 上游模型 metadata 声明的 reasoning 能力（effort / toggle / budget_tokens 三种形态）。 */
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
 * 把上游 capability 归一化成档位映射（effort 按枚举取子集，toggle / budget 视为全档位）。
 */
export function deriveReasoningLevelMap(
    options: ReasoningOption[] | null | undefined
): ReasoningLevelMap {
    const map: ReasoningLevelMap = {};
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
        // effort 枚举是穷尽的：没有 none/off 即表示该模型无法关闭思考。
        map.off = values.has('none') ? 'none' : values.has('off') ? 'off' : null;
        for (const level of REASONING_LEVELS) {
            map[level] = values.has(level) ? level : null;
        }
        return map;
    }

    if (toggle || budget) {
        for (const level of REASONING_LEVELS) {
            map[level] = level;
        }
        return map;
    }

    return map;
}

/**
 * 模型支持的档位。
 *
 * - 不支持 reasoning：只有 `off`。
 * - 映射为 null：不支持，跳过。
 * - `xhigh` / `max` 必须显式映射，否则视为不支持。
 */
export function getSupportedReasoningLevels(
    map: ReasoningLevelMap | null | undefined,
    reasoning = true
): SelectableReasoningLevel[] {
    if (!reasoning) {
        return ['off'];
    }

    return SELECTABLE_REASONING_LEVELS.filter((level) => {
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
 * 把请求档位 clamp 到模型支持的档位。
 *
 * 命中直接返回；否则先向更高档找，再向更低档找；兜底最低档。
 */
export function clampReasoningLevel(
    map: ReasoningLevelMap | null | undefined,
    level: SelectableReasoningLevel
): SelectableReasoningLevel {
    const available = getSupportedReasoningLevels(map, true);
    if (available.includes(level)) {
        return level;
    }

    const requestedIndex = SELECTABLE_REASONING_LEVELS.indexOf(level);
    if (requestedIndex === -1) {
        return available[0] ?? 'off';
    }

    for (let i = requestedIndex; i < SELECTABLE_REASONING_LEVELS.length; i++) {
        const candidate = SELECTABLE_REASONING_LEVELS[i];
        if (candidate !== undefined && available.includes(candidate)) {
            return candidate;
        }
    }

    for (let i = requestedIndex - 1; i >= 0; i--) {
        const candidate = SELECTABLE_REASONING_LEVELS[i];
        if (candidate !== undefined && available.includes(candidate)) {
            return candidate;
        }
    }

    return available[0] ?? 'off';
}

/** 档位对应的思考 token 预算。 */
export function budgetForReasoningLevel(
    level: SelectableReasoningLevel,
    budgets?: ReasoningTokenBudgets
): number | undefined {
    if (level === 'off') {
        return 0;
    }

    const merged = { ...DEFAULT_REASONING_TOKEN_BUDGETS, ...budgets };
    if (level === 'xhigh' || level === 'max') {
        return merged.high;
    }
    return merged[level];
}

/** 把思考预算限制在给回答留出 `MIN_RESPONSE_TOKENS` 的范围内。 */
export function clampBudgetToResponseRoom(budget: number, ceiling?: number): number {
    if (ceiling === undefined || !Number.isFinite(ceiling)) {
        return budget;
    }
    return Math.min(budget, Math.max(0, ceiling - MIN_RESPONSE_TOKENS));
}
