// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { safeParseJsonWithSchema, z } from './zod';

const mcpStringValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const mcpServerArgsSchema = z.array(z.coerce.string());
export const mcpServerRecordSchema = z
    .record(z.string(), mcpStringValueSchema)
    .transform((value) =>
        Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item ?? '')]))
    );

export type McpServerRecord = z.infer<typeof mcpServerRecordSchema>;

export const mcpToolPropertySchema = z
    .object({
        type: z.union([z.string(), z.array(z.string())]).optional(),
        enum: z.array(z.unknown()).optional(),
        description: z.string().optional(),
    })
    .passthrough();

export type McpToolProperty = z.infer<typeof mcpToolPropertySchema>;

export const mcpToolSchemaSchema = z
    .object({
        type: z.string().optional(),
        properties: z.record(z.string(), mcpToolPropertySchema).optional(),
        required: z.array(z.string()).optional(),
    })
    .passthrough()
    .transform((value) => ({
        ...value,
        type: value.type ?? 'object',
        properties: value.properties ?? {},
    }));

export type McpToolSchema = z.infer<typeof mcpToolSchemaSchema>;

/**
 * 解析 MCP stdio 参数 JSON；脏数据时回退为空数组。
 *
 * @param argsJson 数据库存储的 args JSON。
 * @returns 标准化后的参数数组。
 */
export function parseMcpServerArgsJson(argsJson?: string | null): string[] {
    return safeParseJsonWithSchema(mcpServerArgsSchema, argsJson, []);
}

/**
 * 解析 MCP env / headers JSON；脏数据时回退为空对象。
 *
 * @param recordJson 数据库存储的 record JSON。
 * @returns 标准化后的字符串字典。
 */
export function parseMcpServerRecordJson(recordJson?: string | null): McpServerRecord {
    return safeParseJsonWithSchema(mcpServerRecordSchema, recordJson, {});
}

/**
 * 把字符串字典转换为设置页编辑态需要的 key/value 数组。
 *
 * @param record 已标准化的字符串字典。
 * @returns 可直接绑定表单的 key/value 数组。
 */
export function toKeyValueEntries(record: McpServerRecord): Array<{ key: string; value: string }> {
    return Object.entries(record).map(([key, value]) => ({
        key,
        value,
    }));
}

/**
 * 解析 MCP 工具输入 schema JSON；脏数据时至少返回空 object schema。
 *
 * @param schemaJson 数据库存储的 input_schema JSON。
 * @returns 标准化后的 object schema。
 */
export function parseMcpToolSchemaJson(schemaJson?: string | null): McpToolSchema {
    return safeParseJsonWithSchema(mcpToolSchemaSchema, schemaJson, {
        type: 'object',
        properties: {},
    });
}
