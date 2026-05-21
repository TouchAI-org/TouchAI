// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { safeParseJsonWithSchema, z } from './zod';

const DEFAULT_MODEL_MODALITIES = {
    input: ['text'],
    output: ['text'],
} as const;

export const modelModalitiesSchema = z
    .object({
        input: z.array(z.string()).optional(),
        output: z.array(z.string()).optional(),
    })
    .transform((value) => ({
        input: value.input ?? [...DEFAULT_MODEL_MODALITIES.input],
        output: value.output ?? [...DEFAULT_MODEL_MODALITIES.output],
    }));

export type ModelModalities = z.infer<typeof modelModalitiesSchema>;

/**
 * 上游元数据里的 limit 字段偶尔会出现 0、负数或脏字符串。
 * 这里把非法值统一降级为 `undefined`，避免整批模型导入因为单个脏字段失败。
 */
function normalizePositiveLimitValue(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue) || numericValue <= 0) {
        return undefined;
    }

    return numericValue;
}

function isLimitRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const optionalPositiveLimitSchema = z.preprocess(
    (value) => normalizePositiveLimitValue(value),
    z.number().int().positive().optional()
);

export const modelLimitSchema = z
    .preprocess(
        (value) => (isLimitRecord(value) ? value : {}),
        z.object({
            context: optionalPositiveLimitSchema,
            output: optionalPositiveLimitSchema,
        })
    )
    .transform((value) => ({
        ...(value.context ? { context: value.context } : {}),
        ...(value.output ? { output: value.output } : {}),
    }));

export type ModelLimit = z.infer<typeof modelLimitSchema>;

/**
 * 解析模型模态 JSON；脏数据时回退到纯文本输入输出。
 *
 * @param modalitiesJson 数据库存储的模态 JSON。
 * @returns 标准化后的模型模态。
 */
export function parseModelModalities(modalitiesJson?: string | null): ModelModalities {
    return safeParseJsonWithSchema(modelModalitiesSchema, modalitiesJson, {
        input: [...DEFAULT_MODEL_MODALITIES.input],
        output: [...DEFAULT_MODEL_MODALITIES.output],
    });
}

/**
 * 解析模型上下文/输出上限 JSON；脏数据时回退为空对象。
 *
 * @param limitJson 数据库存储的 limit JSON。
 * @returns 标准化后的 limit 结构。
 */
export function parseModelLimit(limitJson?: string | null): ModelLimit {
    return safeParseJsonWithSchema(modelLimitSchema, limitJson, {});
}

/**
 * 序列化模型上下文/输出上限；若两个字段都不可用则返回 `null`。
 *
 * @param limit 已解析的 limit 结构。
 * @returns 可写入数据库的 JSON 字符串或 `null`。
 */
export function serializeModelLimit(limit?: ModelLimit | null): string | null {
    if (!limit?.context && !limit?.output) {
        return null;
    }

    return JSON.stringify(limit);
}

/**
 * 判断模型模态是否包含图像能力。
 *
 * @param modalities 已解析的模型模态。
 * @returns 是否支持图像输入或输出。
 */
export function supportsImageModality(modalities: ModelModalities): boolean {
    return modalities.input.includes('image') || modalities.output.includes('image');
}
