// Copyright (c) 2026. ǧ��. Licensed under GPL v3

import type { ReasoningSegment } from '../contracts/protocol';

/**
 * OpenCode-style ordered output parts. Text and reasoning are stored in the
 * order produced by the model; timestamps belong to reasoning parts only.
 */
export type PersistedOutputPart =
    | {
          type: 'text';
          content: string;
      }
    | {
          type: 'reasoning';
          content: string;
          startedAt?: number;
          endedAt?: number;
          /** Legacy fallback for records written before wall-clock timestamps. */
          durationMs?: number;
      };

/** Normalize both wall-clock records and legacy duration-only history. */
export function normalizeReasoningSegments(raw: unknown): ReasoningSegment[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value): ReasoningSegment[] => {
        if (!value || typeof value !== 'object') return [];
        const segment = value as {
            content?: unknown;
            startedAt?: unknown;
            endedAt?: unknown;
            durationMs?: unknown;
            textOffset?: unknown;
        };
        if (typeof segment.content !== 'string' || !segment.content.trim()) return [];
        const startedAt = isValidTimestamp(segment.startedAt) ? segment.startedAt : undefined;
        const endedAt =
            startedAt !== undefined &&
            isValidTimestamp(segment.endedAt) &&
            segment.endedAt >= startedAt
                ? segment.endedAt
                : undefined;
        const durationMs = isValidTimestamp(segment.durationMs)
            ? Math.round(segment.durationMs)
            : undefined;
        const textOffset = isValidTimestamp(segment.textOffset)
            ? Math.round(segment.textOffset)
            : undefined;
        return [
            {
                content: segment.content,
                ...(startedAt !== undefined ? { startedAt } : {}),
                ...(endedAt !== undefined ? { endedAt } : {}),
                ...(startedAt === undefined && durationMs !== undefined ? { durationMs } : {}),
                ...(textOffset !== undefined ? { textOffset } : {}),
            },
        ];
    });
}

/** Normalize persisted OpenCode-style output parts without changing their order. */
export function normalizeOutputParts(raw: unknown): PersistedOutputPart[] {
    if (!Array.isArray(raw)) return [];

    return raw.flatMap((value): PersistedOutputPart[] => {
        if (!value || typeof value !== 'object') return [];
        const part = value as {
            type?: unknown;
            content?: unknown;
            startedAt?: unknown;
            endedAt?: unknown;
            durationMs?: unknown;
        };
        if (typeof part.content !== 'string') return [];

        if (part.type === 'text') {
            if (part.content.length === 0) return [];
            return [{ type: 'text', content: part.content }];
        }

        if (part.type !== 'reasoning') return [];

        const startedAt = isValidTimestamp(part.startedAt) ? part.startedAt : undefined;
        // A reasoning start is durable even before the first content delta.
        if (part.content.length === 0 && startedAt === undefined) return [];
        const endedAt =
            startedAt !== undefined && isValidTimestamp(part.endedAt) && part.endedAt >= startedAt
                ? part.endedAt
                : undefined;
        const durationMs = isValidTimestamp(part.durationMs)
            ? Math.round(part.durationMs)
            : undefined;

        return [
            {
                type: 'reasoning',
                content: part.content,
                ...(startedAt !== undefined ? { startedAt } : {}),
                ...(endedAt !== undefined ? { endedAt } : {}),
                ...(startedAt === undefined && durationMs !== undefined ? { durationMs } : {}),
            },
        ];
    });
}

/** Convert the old response + reasoning-segment shape to an ordered part list. */
export function outputPartsFromLegacy(
    response: string,
    segments: ReasoningSegment[]
): PersistedOutputPart[] {
    const orderedSegments = segments
        .filter((segment) => segment.content.trim())
        .sort((a, b) => (a.textOffset ?? 0) - (b.textOffset ?? 0));
    const hasTextOffsets = orderedSegments.some((segment) => segment.textOffset !== undefined);
    const parts: PersistedOutputPart[] = [];

    const appendReasoning = (segment: ReasoningSegment) => {
        parts.push({
            type: 'reasoning',
            content: segment.content,
            ...(isValidTimestamp(segment.startedAt) ? { startedAt: segment.startedAt } : {}),
            ...(isValidTimestamp(segment.endedAt) ? { endedAt: segment.endedAt } : {}),
            ...(isValidTimestamp(segment.durationMs) && segment.startedAt === undefined
                ? { durationMs: Math.round(segment.durationMs) }
                : {}),
        });
    };

    if (!hasTextOffsets) {
        for (const segment of orderedSegments) appendReasoning(segment);
        if (response) parts.push({ type: 'text', content: response });
        return parts;
    }

    let textCursor = 0;
    for (const segment of orderedSegments) {
        const textOffset = Math.max(0, Math.min(response.length, segment.textOffset ?? textCursor));
        if (textOffset > textCursor) {
            parts.push({ type: 'text', content: response.slice(textCursor, textOffset) });
        }
        appendReasoning(segment);
        textCursor = Math.max(textCursor, textOffset);
    }
    if (textCursor < response.length) {
        parts.push({ type: 'text', content: response.slice(textCursor) });
    }
    return parts;
}

export function getReasoningSegmentsFromOutputParts(
    parts: PersistedOutputPart[]
): ReasoningSegment[] {
    return parts.flatMap((part): ReasoningSegment[] => {
        if (part.type !== 'reasoning') return [];
        return [
            {
                content: part.content,
                ...(isValidTimestamp(part.startedAt) ? { startedAt: part.startedAt } : {}),
                ...(isValidTimestamp(part.endedAt) ? { endedAt: part.endedAt } : {}),
                ...(isValidTimestamp(part.durationMs) && part.startedAt === undefined
                    ? { durationMs: Math.round(part.durationMs) }
                    : {}),
            },
        ];
    });
}

function isValidTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
