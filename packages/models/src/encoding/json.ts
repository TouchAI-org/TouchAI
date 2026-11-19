import { z } from 'zod';
export { z };

export function safeParseJsonWithSchema<T>(
    schema: z.ZodType<T>,
    rawJson: string | null | undefined,
    fallback: T
): T {
    const normalized = schema.parse(fallback);
    if (!rawJson) return normalized;
    try {
        const parsed = schema.safeParse(JSON.parse(rawJson) as unknown);
        return parsed.success ? parsed.data : normalized;
    } catch {
        return normalized;
    }
}
