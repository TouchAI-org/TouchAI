// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    arrayFromScalarSchema,
    integerInRangeSchema,
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    z,
} from '../../utils/toolSchema';

export const MEMORY_TOOL_ACTIONS = ['read', 'upsert', 'delete'] as const;
export const MEMORY_TOOL_NAME = 'Memory';

const memoryIdSchema = integerInRangeSchema(1, Number.MAX_SAFE_INTEGER);

export const memoryReadArgsSchema = z.object({
    action: z.literal('read'),
    ids: arrayFromScalarSchema(memoryIdSchema).transform((ids) => Array.from(new Set(ids))),
});

export const memoryUpsertArgsSchema = z.object({
    action: z.literal('upsert'),
    id: optionalIntegerInRangeSchema(1, Number.MAX_SAFE_INTEGER),
    title: nonEmptyTrimmedStringSchema,
    applicability: nonEmptyTrimmedStringSchema,
    content: nonEmptyTrimmedStringSchema,
});

export const memoryDeleteArgsSchema = z.object({
    action: z.literal('delete'),
    id: integerInRangeSchema(1, Number.MAX_SAFE_INTEGER),
});

export const memoryArgsSchema = z.discriminatedUnion('action', [
    memoryReadArgsSchema,
    memoryUpsertArgsSchema,
    memoryDeleteArgsSchema,
]);

export type MemoryToolRequest = z.infer<typeof memoryArgsSchema>;

export const MEMORY_TOOL_DESCRIPTION = [
    'Read, create/update, or disable curated long-term memories for the desktop Agent.',
    'Use read before relying on memory content listed in the memory directory.',
    'Use upsert only for durable user preferences, recurring desktop workflows, project context, or corrections likely to matter in future conversations.',
    'Do not store passwords, API keys, transient one-off facts, or content the user would not expect to be durable.',
].join(' ');

export const MEMORY_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: [...MEMORY_TOOL_ACTIONS],
            description:
                'Required. read retrieves memory content, upsert creates or updates durable memory, delete disables a memory.',
        },
        ids: {
            type: 'array',
            items: { type: 'integer' },
            description:
                'Required for read. One or more memory ids from the injected memory directory.',
        },
        id: {
            type: 'integer',
            description: 'Optional for upsert and required for delete. Existing memory id.',
        },
        title: {
            type: 'string',
            description: 'Required for upsert. Short memory name shown in the memory directory.',
        },
        applicability: {
            type: 'string',
            description:
                'Required for upsert. Describe when future agents should read this memory.',
        },
        content: {
            type: 'string',
            description: 'Required for upsert. Durable memory body. Do not include secrets.',
        },
    },
    required: ['action'],
};
