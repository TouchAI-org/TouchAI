// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import { integerInRangeSchema, z } from '../../utils/toolSchema';

export const WEB_BROWSE_COMMANDS = [
    'open',
    'click',
    'find',
    'scroll',
    'extract',
    'evaluate',
] as const;

export const WEB_BROWSE_SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

export const WEB_BROWSE_EXTRACT_MODES = ['reader', 'page_markdown', 'page_text'] as const;

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_CHARS = 50_000;

export type WebBrowseCommand = (typeof WEB_BROWSE_COMMANDS)[number];
export type WebBrowseScrollDirection = (typeof WEB_BROWSE_SCROLL_DIRECTIONS)[number];
export type WebBrowseExtractMode = (typeof WEB_BROWSE_EXTRACT_MODES)[number];

export const WEB_BROWSE_TOOL_NAME = 'WebBrowse';
export const webBrowseArgsSchema = z.object({
    command: z.enum(WEB_BROWSE_COMMANDS),
    url: z.string().optional(),
    selector: z.string().optional(),
    direction: z.enum(WEB_BROWSE_SCROLL_DIRECTIONS).optional(),
    pixels: integerInRangeSchema(1, 10_000).optional(),
    mode: z.enum(WEB_BROWSE_EXTRACT_MODES).optional(),
    maxChars: integerInRangeSchema(100, 200_000).optional(),
    script: z.string().optional(),
    timeoutMs: integerInRangeSchema(1_000, 60_000).optional(),
});

/**
 * 暴露给模型的 WebBrowse 工具说明。
 */
export const WEB_BROWSE_TOOL_DESCRIPTION =
    'Browse interactive web pages with JavaScript rendering. Supports navigation, clicking elements, finding text, scrolling, extracting content, and evaluating JavaScript.';

function withExamples(description: string, ...examples: string[]): string {
    return `${description} Examples: ${examples.join(' | ')}.`;
}

/**
 * 暴露给模型的 WebBrowse 工具输入 schema。
 */
export const WEB_BROWSE_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        command: {
            type: 'string',
            enum: [...WEB_BROWSE_COMMANDS],
            description: withExamples(
                'The browse command to execute. open navigates to a URL, click clicks an element, find searches for text, scroll moves the page, extract gets page content, evaluate runs JavaScript.',
                '"open"',
                '"click"',
                '"find"',
                '"extract"'
            ),
        },
        url: {
            type: 'string',
            description: withExamples(
                'Required for the open command. The URL to navigate to.',
                '"https://example.com"'
            ),
        },
        selector: {
            type: 'string',
            description: withExamples(
                'CSS selector for click command, or text pattern for find command.',
                '".submit-button"',
                '"#main-content"',
                '"Sign Up"'
            ),
        },
        direction: {
            type: 'string',
            enum: [...WEB_BROWSE_SCROLL_DIRECTIONS],
            description: withExamples(
                'Scroll direction for the scroll command. Defaults to "down".',
                '"down"',
                '"up"'
            ),
        },
        pixels: {
            type: 'integer',
            description: withExamples(
                'Scroll distance in pixels for the scroll command. Default 500.',
                '500',
                '1000'
            ),
        },
        mode: {
            type: 'string',
            enum: [...WEB_BROWSE_EXTRACT_MODES],
            description: withExamples(
                'Content extraction mode for the extract command. reader extracts main article, page_markdown converts to Markdown, page_text returns plain text.',
                '"reader"',
                '"page_markdown"',
                '"page_text"'
            ),
        },
        maxChars: {
            type: 'integer',
            description: withExamples(
                'Maximum output characters for the extract command. Default 50000.',
                '10000',
                '50000'
            ),
        },
        script: {
            type: 'string',
            description: withExamples(
                'JavaScript code for the evaluate command. The return value is sent back as the result.',
                '"document.title"',
                '"document.querySelectorAll(\'a\').length"'
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
    required: ['command'],
};
