// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { normalizeOptionalString } from './text';

import { z } from 'zod';

export { z };

/**
 * 非空字符串统一先做 trim，再交给后续 schema 使用。
 */
export const nonEmptyTrimmedStringSchema = z.preprocess(
    (value) => normalizeOptionalString(value),
    z.string()
);

/**
 * 可选字符串统一先做 trim，空串和非字符串都视为 `undefined`。
 */
export const optionalTrimmedStringSchema = z.preprocess(
    (value) => normalizeOptionalString(value),
    z.string().optional()
);

/**
 * 必填整数统一做 number coercion 与范围限制。
 */
export function integerInRangeSchema(minimum: number, maximum: number) {
    return z.preprocess((value) => {
        if (value === '') {
            return undefined;
        }

        return value;
    }, z.coerce.number().int().min(minimum).max(maximum));
}

/**
 * 可选整数统一做 number coercion 与范围限制。
 */
export function optionalIntegerInRangeSchema(minimum: number, maximum: number) {
    return z.preprocess((value) => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }

        return value;
    }, z.coerce.number().int().min(minimum).max(maximum).optional());
}

/**
 * 把单个标量值提升为数组，便于兼容“单值”和“数组”混用的输入源。
 */
export function arrayFromScalarSchema<T extends z.ZodTypeAny>(itemSchema: T) {
    return z.preprocess((value) => {
        if (value === undefined || value === null) {
            return [];
        }

        return Array.isArray(value) ? value : [value];
    }, z.array(itemSchema));
}

/**
 * 用 schema 解析 JSON 字符串，并在语法非法时抛出统一错误。
 *
 * @param schema 目标结构 schema。
 * @param rawJson 原始 JSON 字符串。
 * @param invalidJsonMessage JSON 语法错误时使用的错误消息。
 * @returns 通过 schema 解析后的结果。
 */
export function parseJsonWithSchema<T>(
    schema: z.ZodType<T>,
    rawJson: string,
    invalidJsonMessage: string = 'JSON 解析失败。'
): T {
    let parsed: unknown;

    try {
        parsed = JSON.parse(rawJson) as unknown;
    } catch {
        throw new Error(invalidJsonMessage);
    }

    return schema.parse(parsed);
}

/**
 * 用 schema 安全解析可选 JSON 字符串，失败时回退到默认值。
 *
 * @param schema 目标结构 schema。
 * @param rawJson 原始 JSON 字符串。
 * @param fallback 解析失败时返回的默认值。
 * @returns 解析结果或标准化后的默认值。
 */
export function safeParseJsonWithSchema<T>(
    schema: z.ZodType<T>,
    rawJson: string | null | undefined,
    fallback: T
): T {
    const normalizedFallback = schema.parse(fallback);
    if (!rawJson) {
        return normalizedFallback;
    }

    try {
        const parsed = JSON.parse(rawJson) as unknown;
        const result = schema.safeParse(parsed);
        return result.success ? result.data : normalizedFallback;
    } catch {
        return normalizedFallback;
    }
}
