// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    arrayFromScalarSchema,
    integerInRangeSchema,
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    optionalTrimmedStringSchema,
    safeParseJsonWithSchema,
    z,
} from '@/utils/zod';

export {
    arrayFromScalarSchema,
    integerInRangeSchema,
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    optionalTrimmedStringSchema,
    z,
};

function formatIssuePath(path: readonly PropertyKey[]): string {
    return path.length > 0 ? `"${path.map((segment) => String(segment)).join('.')}"` : 'input';
}

function formatZodError(error: z.ZodError): string {
    return error.issues
        .map((issue) => `- ${formatIssuePath(issue.path)}: ${issue.message}`)
        .join('\n');
}

/**
 * 用统一格式解析工具参数，避免每个工具重复拼接校验错误。
 */
export function parseToolArguments<T>(toolName: string, schema: z.ZodType<T>, args: unknown): T {
    const result = schema.safeParse(args);
    if (result.success) {
        return result.data;
    }

    throw new Error(
        `${toolName} tool received invalid arguments.\n${formatZodError(result.error)}`
    );
}

/**
 * 解析数据库中的工具配置 JSON。
 *
 * 配置解析失败时回退到默认配置，避免脏数据阻断整个工具注册链。
 */
export function parseToolConfigJson<T>(
    schema: z.ZodType<T>,
    configJson: string | null,
    defaultConfig: T
): T {
    return safeParseJsonWithSchema(schema, configJson, defaultConfig);
}
