// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    z,
} from '../../utils/toolSchema';

export const READ_TOOL_NAME = 'Read';
export const DEFAULT_READ_OFFSET = 1;
export const DEFAULT_READ_LIMIT = 2000;
export const MAX_READ_LIMIT = 2000;
export const MAX_LINE_LENGTH = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const MAX_BINARY_SNIFF_BYTES = 4096;
export const MAX_SUGGESTIONS = 3;
export const MAX_READ_BYTES_LABEL = `${MAX_READ_BYTES / 1024} KB`;

export const rasterImageExtensions = new Set([
    'avif',
    'bmp',
    'gif',
    'ico',
    'jpeg',
    'jpg',
    'png',
    'tif',
    'tiff',
    'webp',
]);

export const readArgsSchema = z.object({
    filePath: nonEmptyTrimmedStringSchema,
    offset: optionalIntegerInRangeSchema(1, Number.MAX_SAFE_INTEGER),
    limit: optionalIntegerInRangeSchema(1, MAX_READ_LIMIT),
});

function withExamples(description: string, ...examples: string[]): string {
    return `${description} Examples: ${examples.join(' | ')}.`;
}

export const READ_TOOL_DESCRIPTION = [
    'Read local files or directories.',
    'Text and code files are returned by line; use offset and limit for pagination.',
    'Images and PDFs are returned as tool-result attachments instead of being forced into plain text.',
    'Prefer absolute paths returned by FileSearch.',
].join(' ');

export const READ_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        filePath: {
            type: 'string',
            description: withExamples(
                'Required absolute or desktop-relative local path to a file or directory.',
                '"D:\\\\Project\\\\TouchAI\\\\README.md"',
                '"D:\\\\Users\\\\me\\\\Pictures\\\\diagram.png"'
            ),
        },
        offset: {
            type: 'integer',
            description: withExamples(
                'Optional 1-based line number or directory entry index to start from. Defaults to 1.',
                '1',
                '201'
            ),
        },
        limit: {
            type: 'integer',
            description: withExamples(
                `Optional maximum number of lines or directory entries to return. Defaults to ${DEFAULT_READ_LIMIT}.`,
                '200',
                '800'
            ),
        },
    },
    required: ['filePath'],
};
