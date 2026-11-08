// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { z } from '@/utils/zod';

export const MAX_SUMMARY_CHARS = 32_000;

/** A completed checkpoint. The original transcript remains the source of truth. */
const contextSummarySchema = z
    .object({
        version: z.literal(1),
        id: z.string().uuid(),
        text: z.string().trim().min(1).max(MAX_SUMMARY_CHARS),
        covered: z.number().int().positive(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        pinnedUser: z.number().int().nonnegative().optional(),
        model: z.string().min(1),
        providerId: z.number().int().positive().optional(),
        createdAt: z.number().int().nonnegative(),
        tokensBefore: z.number().int().nonnegative(),
        tokensAfter: z.number().int().nonnegative(),
    })
    .refine((value) => value.pinnedUser === undefined || value.pinnedUser < value.covered);

export type ContextSummary = z.infer<typeof contextSummarySchema>;

/** Imported or future records must never become an unchecked model projection. */
export function readContextSummary(part: {
    type: string;
    content: string;
    data: string;
}): ContextSummary | undefined {
    if (part.type !== 'context_compaction') return undefined;
    try {
        const metadata: unknown = JSON.parse(part.data);
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
        const result = contextSummarySchema.safeParse({ ...metadata, text: part.content });
        return result.success ? result.data : undefined;
    } catch {
        return undefined;
    }
}
