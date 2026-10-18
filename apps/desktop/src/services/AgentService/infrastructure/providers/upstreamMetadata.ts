// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    type ModelModalities,
    modelModalitiesSchema,
    normalizePositiveLimitValue,
} from '@/utils/modelSchemas';

import { normalizeReasoningOptions, type ReasoningOption } from '../../contracts/reasoning';
import type { ModelCapabilities } from './types';

/**
 * 上游 `/v1/models` 没有统一标准：OpenAI 只保证 `id`，中转站 / 网关会各自追加
 * 上下文长度、模态、思考档位等字段。这里按常见命名嗅探并归一化成领域能力，
 * 缺失的字段交给 models.dev 兜底。
 *
 * 已确认形态：Magpie 等网关的 `context_window` / `supported_reasoning_levels`、
 * OpenRouter 的 `top_provider` / `architecture.*` / `supported_efforts`、
 * Vercel AI Gateway 的 `reasoning_options`。
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

function firstPositiveLimit(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = normalizePositiveLimitValue(record[key]);
        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
}

/** 兼容 `modalities` 与 OpenRouter 的 `architecture.*`；未声明模态时返回 undefined。 */
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

/** 汇总 `supported_reasoning_levels`（`[{effort}]`）与 `reasoning.supported_efforts`。 */
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

function resolveToolCall(record: Record<string, unknown>): boolean | undefined {
    const declared =
        toBoolean(record.tool_call) ??
        toBoolean(record.toolCall) ??
        toBoolean(record.supports_tools);
    if (declared !== undefined) {
        return declared;
    }

    const supportedParameters = record.supported_parameters;
    if (
        Array.isArray(supportedParameters) &&
        supportedParameters.some(
            (parameter) => parameter === 'tools' || parameter === 'tool_choice'
        )
    ) {
        return true;
    }

    return undefined;
}

/** 只保留上游明确声明的字段；返回 undefined 表示该上游没有可用能力元数据。 */
export function normalizeUpstreamModelCapabilities(raw: unknown): ModelCapabilities | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }

    const capabilities: ModelCapabilities = {};

    const contextLimit = firstPositiveLimit(raw, CONTEXT_LIMIT_KEYS);
    if (contextLimit !== undefined) {
        capabilities.contextLimit = contextLimit;
    }

    const topProvider = isRecord(raw.top_provider) ? raw.top_provider : {};
    const outputLimit =
        firstPositiveLimit(raw, OUTPUT_LIMIT_KEYS) ??
        firstPositiveLimit(topProvider, TOP_PROVIDER_OUTPUT_KEYS);
    if (outputLimit !== undefined) {
        capabilities.outputLimit = outputLimit;
    }

    const modalities = normalizeUpstreamModalities(raw);
    if (modalities) {
        capabilities.modalities = modalities;
    }

    const declaredAttachment = toBoolean(raw.attachment);
    if (declaredAttachment !== undefined) {
        capabilities.attachment = declaredAttachment;
    } else if (modalities?.input.some((modality) => FILE_INPUT_MODALITIES.has(modality))) {
        capabilities.attachment = true;
    }

    const toolCall = resolveToolCall(raw);
    if (toolCall !== undefined) {
        capabilities.toolCall = toolCall;
    }

    const reasoningOptions = resolveReasoningOptions(raw);
    if (reasoningOptions.length > 0) {
        capabilities.reasoningOptions = reasoningOptions;
        capabilities.reasoning = true;
    } else {
        const declaredReasoning = toBoolean(raw.reasoning) ?? toBoolean(raw.supports_reasoning);
        if (declaredReasoning !== undefined) {
            capabilities.reasoning = declaredReasoning;
        }
    }

    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}
