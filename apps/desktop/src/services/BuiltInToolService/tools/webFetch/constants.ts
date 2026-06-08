// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

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
export const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
export const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7';
export const MAX_WEB_FETCH_REDIRECTS = 10;
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
    maxResponseBytes: optionalIntegerInRangeSchema(50_000, 10_000_000),
});

/**
 * 暴露给模型的 WebFetch 工具说明。
 */
export const WEB_FETCH_TOOL_DESCRIPTION = [
    'Fetch known public web pages and extract readable text.',
    'Use builtin__web_search for discovery; use builtin__web_fetch only after you already know the exact URL to read.',
].join(' ');

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
                'Required public http(s) URL to fetch. Localhost, intranet and private-network hosts are blocked. For discovery, call builtin__web_search instead of fetching search result pages.',
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
        maxResponseBytes: {
            type: 'integer',
            description: withExamples(
                'Optional maximum response bytes to read before conversion. Defaults to 2000000.',
                '500000',
                '2000000'
            ),
        },
    },
    required: ['url', 'mode', 'maxChars'],
};
