import { z } from '@/utils/zod';

import {
    READ_CONVERSATION_DEFAULT_LIMIT,
    READ_CONVERSATION_DEFAULT_MAX_CHARS,
    READ_CONVERSATION_MAX_LIMIT,
    READ_CONVERSATION_MAX_MAX_CHARS,
    READ_CONVERSATION_MIN_MAX_CHARS,
} from './constants';

const readConversationArgsSchema = z
    .object({
        session_id: z.string().trim().min(1),
        message_id: z.number().int().min(1).optional(),
        direction: z.enum(['before', 'after']).default('before'),
        limit: z
            .number()
            .int()
            .min(1)
            .max(READ_CONVERSATION_MAX_LIMIT)
            .default(READ_CONVERSATION_DEFAULT_LIMIT),
        max_chars_per_message: z
            .number()
            .int()
            .min(READ_CONVERSATION_MIN_MAX_CHARS)
            .max(READ_CONVERSATION_MAX_MAX_CHARS)
            .default(READ_CONVERSATION_DEFAULT_MAX_CHARS),
        role: z.enum(['user', 'assistant']).optional(),
    })
    .strict();

export type ReadConversationArguments = z.infer<typeof readConversationArgsSchema> & {
    roles: readonly ('user' | 'assistant')[];
};

export function parseReadConversationArguments(
    value: Record<string, unknown>
): ReadConversationArguments {
    const parsed = readConversationArgsSchema.parse(value);
    return {
        ...parsed,
        roles: parsed.role ? [parsed.role] : ['user', 'assistant'],
    };
}

export function truncateText(value: string, limit: number): { text: string; truncated: boolean } {
    const points = Array.from(value);
    if (points.length <= limit) return { text: value, truncated: false };
    return { text: points.slice(0, Math.max(0, limit)).join(''), truncated: true };
}

export function utf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).length;
}
