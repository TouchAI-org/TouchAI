// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AiService/types';

import {
    integerInRangeSchema,
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    z,
} from '../../utils/toolSchema';

export const WEB_FETCH_MODES = ['reader', 'page_markdown', 'page_text'] as const;
export const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_SOURCE_CHAR_LIMIT = 1_500_000;
export const DEFAULT_ACCEPT_HEADER = [
    'text/html',
    'application/xhtml+xml',
    'text/markdown;q=0.95',
    'text/plain;q=0.9',
    'application/json;q=0.9',
    '*/*;q=0.5',
].join(', ');

export type WebFetchMode = (typeof WEB_FETCH_MODES)[number];

export const WEB_FETCH_TOOL_NAME = 'WebFetch';
export const webFetchArgsSchema = z.object({
    url: nonEmptyTrimmedStringSchema,
    mode: z.enum(WEB_FETCH_MODES),
    maxChars: integerInRangeSchema(500, 40_000),
    timeoutMs: optionalIntegerInRangeSchema(1_000, 60_000),
});

/**
 * 暴露给模型的 WebFetch 工具说明。
 */
export const WEB_FETCH_TOOL_DESCRIPTION = '抓取网页并提取易读文本';

function withExamples(description: string, ...examples: string[]): string {
    return `${description} Examples: ${examples.join(' | ')}.`;
}

/**
 * 暴露给模型的 WebFetch 工具输入 schema。
 */
export const WEB_FETCH_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        url: {
            type: 'string',
            description: withExamples(
                'Required public http(s) URL to fetch. Localhost, intranet and private-network hosts are blocked.',
                '"https://developer.mozilla.org/en-US/docs/Web/API/DOMParser"',
                '"https://tauri.app/plugin/http/"'
            ),
        },
        mode: {
            type: 'string',
            enum: [...WEB_FETCH_MODES],
            description: withExamples(
                'Required extraction mode. reader prefers main article content, page_markdown converts the visible page to Markdown, and page_text returns normalized plain text.',
                '"reader"',
                '"page_markdown"',
                '"page_text"'
            ),
        },
        maxChars: {
            type: 'integer',
            description: withExamples(
                'Required maximum number of output characters after conversion and cleanup.',
                '6000',
                '12000'
            ),
        },
        timeoutMs: {
            type: 'integer',
            description: withExamples(
                'Optional request timeout in milliseconds. Defaults to 20000.',
                '10000',
                '30000'
            ),
        },
    },
    required: ['url', 'mode', 'maxChars'],
};
