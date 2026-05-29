// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    arrayFromScalarSchema,
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    optionalTrimmedStringSchema,
    z,
} from '../../utils/toolSchema';

export const KEYWORD_MODES = ['any', 'all'] as const;
export const SEARCH_CONVERSATION_ROLES = ['user', 'assistant'] as const;
export const SEARCH_CONVERSATION_TOOL_NAME = 'SearchConversation';

export const searchConversationArgsSchema = z
    .object({
        query: optionalTrimmedStringSchema,
        keywords: arrayFromScalarSchema(nonEmptyTrimmedStringSchema),
        keyword_mode: z.enum(KEYWORD_MODES).default('any'),
        limit: optionalIntegerInRangeSchema(1, 50).default(10),
        from_date: optionalTrimmedStringSchema,
        to_date: optionalTrimmedStringSchema,
        model: optionalTrimmedStringSchema,
        role: z.enum(SEARCH_CONVERSATION_ROLES).optional(),
    })
    .refine((value) => Boolean(value.query || value.keywords.length > 0), {
        message: 'Provide query or at least one keyword.',
        path: ['query'],
    });

export type SearchConversationRequest = z.infer<typeof searchConversationArgsSchema>;

export const SEARCH_CONVERSATION_TOOL_DESCRIPTION = [
    'Search past TouchAI conversation sessions by title, preview, and user/assistant message content.',
    'Use this when prior conversation context may help with desktop tasks, user preferences, recurring workflows, or project continuity.',
    'Supports multiple keywords with any/all matching plus optional date, model, and role filters.',
].join(' ');

export const SEARCH_CONVERSATION_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description:
                'Optional single search query. Combine with keywords for broader or narrower matching.',
        },
        keywords: {
            type: 'array',
            items: { type: 'string' },
            description:
                'Optional multiple keywords. Use keyword_mode to require any or all of them.',
        },
        keyword_mode: {
            type: 'string',
            enum: [...KEYWORD_MODES],
            description:
                'Optional. any returns sessions matching at least one keyword; all requires every keyword. Defaults to any.',
        },
        limit: {
            type: 'integer',
            description: 'Optional result count from 1 to 50. Defaults to 10.',
        },
        from_date: {
            type: 'string',
            description: 'Optional ISO date lower bound on session creation time.',
        },
        to_date: {
            type: 'string',
            description: 'Optional ISO date upper bound on session creation time.',
        },
        model: {
            type: 'string',
            description: 'Optional exact session model filter.',
        },
        role: {
            type: 'string',
            enum: [...SEARCH_CONVERSATION_ROLES],
            description: 'Optional message role filter for content matches.',
        },
    },
    required: [],
};
