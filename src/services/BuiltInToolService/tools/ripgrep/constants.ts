// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * Ripgrep 内置工具的静态定义。
 *
 * 包含 Zod 参数校验 schema、暴露给模型的 JSON Schema、工具描述和默认常量。
 */

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    arrayFromScalarSchema,
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    optionalTrimmedStringSchema,
    z,
} from '../../utils/toolSchema';

export const RIPGREP_TOOL_NAME = 'Ripgrep';
/** 原生侧默认超时，与 ripgrep.rs 中的 DEFAULT_TIMEOUT_MS 保持一致。 */
export const DEFAULT_RIPGREP_TIMEOUT_MS = 15_000;
/** 默认最多返回的匹配条数。 */
export const DEFAULT_RIPGREP_MAX_RESULTS = 50;
export const MAX_RIPGREP_MAX_RESULTS = 200;

/** 模型传入参数的 Zod 校验 schema。 */
export const ripgrepArgsSchema = z.object({
    pattern: nonEmptyTrimmedStringSchema,
    paths: z.array(nonEmptyTrimmedStringSchema).min(1),
    workingDirectory: optionalTrimmedStringSchema,
    caseSensitive: z.boolean().optional(),
    fixedStrings: z.boolean().optional(),
    wordRegexp: z.boolean().optional(),
    hidden: z.boolean().optional(),
    followSymlinks: z.boolean().optional(),
    glob: arrayFromScalarSchema(nonEmptyTrimmedStringSchema),
    fileType: arrayFromScalarSchema(nonEmptyTrimmedStringSchema),
    beforeContext: optionalIntegerInRangeSchema(0, 5),
    afterContext: optionalIntegerInRangeSchema(0, 5),
    maxResults: optionalIntegerInRangeSchema(1, MAX_RIPGREP_MAX_RESULTS),
});

export const RIPGREP_TOOL_DESCRIPTION = [
    'Search file contents with ripgrep (rg).',
    'PREFERRED tool for finding code definitions, function usages, string literals, config values, or any content inside files.',
    'Use this INSTEAD of reading files manually or running bash grep — ripgrep is faster, respects .gitignore, and returns structured results.',
    'Only use file_search when you need to locate files by NAME or PATH; use Ripgrep when you need to locate content INSIDE files.',
    'Always pass one or more explicit directories to search (e.g. ["src"] or ["src", "lib"]).',
    'Supports regex by default; set fixedStrings=true for literal matching.',
    'Respects .gitignore by default; set hidden=true to include hidden files.',
    'Use fileType to narrow by language (e.g. ["ts", "tsx"] for TypeScript).',
].join(' ');

export const RIPGREP_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        pattern: { type: 'string', description: 'Required regex or literal search pattern.' },
        paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Required file or directory paths to search.',
            minItems: 1,
        },
        workingDirectory: { type: 'string', description: 'Optional working directory.' },
        caseSensitive: { type: 'boolean', description: 'Force case-sensitive search.' },
        fixedStrings: { type: 'boolean', description: 'Treat pattern as a literal string.' },
        wordRegexp: { type: 'boolean', description: 'Match whole words only.' },
        hidden: { type: 'boolean', description: 'Include hidden files and directories.' },
        followSymlinks: { type: 'boolean', description: 'Follow symbolic links.' },
        glob: { type: 'array', items: { type: 'string' }, description: 'Optional glob filters.' },
        fileType: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional ripgrep type filters.',
        },
        beforeContext: {
            type: 'integer',
            description: 'Optional context lines before each match.',
        },
        afterContext: { type: 'integer', description: 'Optional context lines after each match.' },
        maxResults: { type: 'integer', description: 'Optional maximum match count to return.' },
    },
    required: ['pattern', 'paths'],
    additionalProperties: false,
};
