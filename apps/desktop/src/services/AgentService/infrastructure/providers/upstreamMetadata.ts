// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UpstreamModelMetadataPatch } from '@database/types';

import {
    type ModelModalities,
    modelModalitiesSchema,
    normalizePositiveLimitValue,
} from '@/utils/modelSchemas';

import {
    normalizeReasoningOptions,
    type ReasoningOption,
    serializeReasoningOptions,
} from '../../contracts/reasoning';

/**
 * 上游 `/v1/models` 没有统一标准：OpenAI 只保证 `id`，而中转站 / 网关会各自追加
 * 上下文长度、模态、思考档位等字段。这里按常见命名嗅探并归一化成数据库列，
 * 缺失的字段交给 models.dev 兜底。
 *
 * 已确认的来源形态：
 * - Magpie 等网关：`context_window` / `context_length`、`max_input_tokens` /
 *   `max_output_tokens`、`modalities`、`reasoning`、`supported_reasoning_levels`
 *   （含网关独有的 `ultra` 档位，统一档位里已有对应项）。
 * - OpenRouter：`context_length`、`top_provider.max_completion_tokens`、
 *   `architecture.input_modalities`、`reasoning.supported_efforts`、
 *   `supported_parameters`。
 * - Vercel AI Gateway：`reasoning_options`（就是 TouchAI 存储的同款结构）。
 */

/** 上下文长度字段，按可信度排序。 */
const CONTEXT_LIMIT_KEYS = [
    'context_window',
    'context_length',
    'max_input_tokens',
    'max_context_tokens',
];

/** 输出上限字段，按可信度排序。 */
const OUTPUT_LIMIT_KEYS = ['max_output_tokens', 'max_completion_tokens', 'max_tokens'];

/** 部分上游把补全上限放在 `top_provider` 子对象里。 */
const TOP_PROVIDER_OUTPUT_KEYS = ['max_completion_tokens', 'max_output_tokens'];

/** 上游声明了文件类输入模态时，视为支持附件。 */
const FILE_INPUT_MODALITIES = new Set(['file', 'pdf', 'document']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function toBit(value: boolean): number {
    return value ? 1 : 0;
}

function firstPositiveLimit(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = normalizePositiveLimitValue(record[key]);
        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
}

/**
 * 归一化模态声明，兼容 `modalities` 与 OpenRouter 的 `architecture.*` 两种写法。
 * 完全没有模态字段时返回 `undefined`，避免用默认值覆盖兜底元数据。
 */
function normalizeUpstreamModalities(record: Record<string, unknown>): ModelModalities | undefined {
    const architecture = isRecord(record.architecture) ? record.architecture : {};
    const modalities = isRecord(record.modalities) ? record.modalities : {};

    const input = modalities.input ?? architecture.input_modalities ?? architecture.inputModalities;
    const output =
        modalities.output ?? architecture.output_modalities ?? architecture.outputModalities;

    if (!Array.isArray(input) && !Array.isArray(output)) {
        return undefined;
    }

    const parsed = modelModalitiesSchema.safeParse({
        ...(Array.isArray(input) ? { input } : {}),
        ...(Array.isArray(output) ? { output } : {}),
    });

    return parsed.success ? parsed.data : undefined;
}

/**
 * 汇总上游声明的思考档位，兼容网关的 `supported_reasoning_levels`（`[{effort}]`）
 * 与 OpenRouter 的 `reasoning.supported_efforts`（字符串数组）。
 */
function collectReasoningEfforts(record: Record<string, unknown>): string[] {
    const rawEfforts: unknown[] = [];

    const levels = record.supported_reasoning_levels;
    if (Array.isArray(levels)) {
        for (const level of levels) {
            if (isRecord(level)) {
                rawEfforts.push(level.effort);
            }
        }
    }

    const reasoning = isRecord(record.reasoning) ? record.reasoning : null;
    if (Array.isArray(reasoning?.supported_efforts)) {
        rawEfforts.push(...reasoning.supported_efforts);
    }

    const values = new Set<string>();
    for (const effort of rawEfforts) {
        if (typeof effort !== 'string') {
            continue;
        }

        const normalized = effort.trim().toLowerCase();
        if (normalized.length === 0) {
            continue;
        }

        values.add(normalized);
    }

    return Array.from(values);
}

function resolveReasoningOptions(record: Record<string, unknown>): ReasoningOption[] {
    const declared = normalizeReasoningOptions(record.reasoning_options);
    if (declared.length > 0) {
        return declared;
    }

    const efforts = collectReasoningEfforts(record);
    return efforts.length > 0 ? [{ type: 'effort', values: efforts }] : [];
}

function resolveToolCall(record: Record<string, unknown>): number | undefined {
    const declared =
        toBoolean(record.tool_call) ??
        toBoolean(record.toolCall) ??
        toBoolean(record.supports_tools);
    if (declared !== undefined) {
        return toBit(declared);
    }

    const supportedParameters = record.supported_parameters;
    if (
        Array.isArray(supportedParameters) &&
        supportedParameters.some(
            (parameter) => parameter === 'tools' || parameter === 'tool_choice'
        )
    ) {
        return 1;
    }

    return undefined;
}

/**
 * 把上游 `/models` 返回的单个模型归一化成可写入数据库的能力字段。
 *
 * 只保留上游明确声明的字段；返回 `undefined` 表示该上游没有可用的能力元数据，
 * 应继续使用 models.dev 兜底值。
 */
export function normalizeUpstreamModelMetadata(
    raw: unknown
): UpstreamModelMetadataPatch | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }

    const patch: UpstreamModelMetadataPatch = {};

    const contextLimit = firstPositiveLimit(raw, CONTEXT_LIMIT_KEYS);
    if (contextLimit !== undefined) {
        patch.context_limit = contextLimit;
    }

    const topProvider = isRecord(raw.top_provider) ? raw.top_provider : {};
    const outputLimit =
        firstPositiveLimit(raw, OUTPUT_LIMIT_KEYS) ??
        firstPositiveLimit(topProvider, TOP_PROVIDER_OUTPUT_KEYS);
    if (outputLimit !== undefined) {
        patch.output_limit = outputLimit;
    }

    const modalities = normalizeUpstreamModalities(raw);
    if (modalities) {
        patch.modalities = JSON.stringify(modalities);
    }

    const declaredAttachment = toBoolean(raw.attachment);
    if (declaredAttachment !== undefined) {
        patch.attachment = toBit(declaredAttachment);
    } else if (modalities?.input.some((modality) => FILE_INPUT_MODALITIES.has(modality))) {
        patch.attachment = 1;
    }

    const toolCall = resolveToolCall(raw);
    if (toolCall !== undefined) {
        patch.tool_call = toolCall;
    }

    const reasoningOptions = resolveReasoningOptions(raw);
    const serializedReasoningOptions = serializeReasoningOptions(reasoningOptions);
    if (serializedReasoningOptions) {
        patch.reasoning_options = serializedReasoningOptions;
        patch.reasoning = 1;
    } else {
        const declaredReasoning = toBoolean(raw.reasoning) ?? toBoolean(raw.supports_reasoning);
        if (declaredReasoning !== undefined) {
            patch.reasoning = toBit(declaredReasoning);
        }
    }

    return Object.keys(patch).length > 0 ? patch : undefined;
}
