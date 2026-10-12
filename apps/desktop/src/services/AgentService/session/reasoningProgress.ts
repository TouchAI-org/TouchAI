import type { ReasoningSegment } from '../contracts/protocol';
export type PersistedOutputPart =
    | { type: 'text'; content: string }
    | { type: 'reasoning'; content: string; startedAt?: number; endedAt?: number };
/** Validate the sole persisted output format without changing logical order. */
export function normalizeOutputParts(raw: unknown): PersistedOutputPart[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value): PersistedOutputPart[] => {
        if (!value || typeof value !== 'object') return [];
        const part = value as {
            type?: unknown;
            content?: unknown;
            startedAt?: unknown;
            endedAt?: unknown;
        };
        if (typeof part.content !== 'string') return [];
        if (part.type === 'text')
            return part.content ? [{ type: 'text', content: part.content }] : [];
        if (part.type !== 'reasoning') return [];
        const startedAt = validTime(part.startedAt) ? part.startedAt : undefined;
        if (!part.content && startedAt === undefined) return [];
        const endedAt =
            startedAt !== undefined && validTime(part.endedAt) && part.endedAt >= startedAt
                ? part.endedAt
                : undefined;
        return [
            {
                type: 'reasoning',
                content: part.content,
                ...(startedAt !== undefined ? { startedAt } : {}),
                ...(endedAt !== undefined ? { endedAt } : {}),
            },
        ];
    });
}
export function getReasoningSegmentsFromOutputParts(
    parts: PersistedOutputPart[]
): ReasoningSegment[] {
    return parts.flatMap((part) =>
        part.type === 'reasoning'
            ? [
                  {
                      content: part.content,
                      ...(part.startedAt !== undefined ? { startedAt: part.startedAt } : {}),
                      ...(part.endedAt !== undefined ? { endedAt: part.endedAt } : {}),
                  },
              ]
            : []
    );
}
function validTime(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
