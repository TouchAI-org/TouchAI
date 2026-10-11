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

export interface PersistedOutputProgress {
    version: 2;
    parts: PersistedOutputPart[];
    savedAt: number;
}

export interface LegacyPersistedOutputProgress {
    response: string;
    segments: ReasoningSegment[];
    savedAt: number;
}

export type ParsedOutputProgress = PersistedOutputProgress | LegacyPersistedOutputProgress;

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
        if (typeof part.content !== 'string' || part.content.length === 0) return [];

        if (part.type === 'text') {
            return [{ type: 'text', content: part.content }];
        }

        if (part.type !== 'reasoning') return [];

        const startedAt = isValidTimestamp(part.startedAt) ? part.startedAt : undefined;
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

export function getOutputPartText(parts: PersistedOutputPart[]): string {
    return parts
        .filter(
            (part): part is Extract<PersistedOutputPart, { type: 'text' }> => part.type === 'text'
        )
        .map((part) => part.content)
        .join('');
}

export function getOutputPartReasoning(parts: PersistedOutputPart[]): string {
    return parts
        .filter(
            (part): part is Extract<PersistedOutputPart, { type: 'reasoning' }> =>
                part.type === 'reasoning'
        )
        .map((part) => part.content)
        .join('');
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

/** Serialize the canonical ordered part metadata stored on a message. */
export function serializeOutputParts(parts: PersistedOutputPart[]): string {
    return JSON.stringify({ version: 2, parts: normalizeOutputParts(parts) });
}

/**
 * Serialize a temporary checkpoint. The legacy overload is intentionally kept so old callers
 * and already-written snapshots remain readable during the migration.
 */
export function serializeOutputProgress(parts: PersistedOutputPart[], savedAt: number): string;
export function serializeOutputProgress(
    response: string,
    segments: ReasoningSegment[],
    savedAt: number
): string;
export function serializeOutputProgress(
    partsOrResponse: PersistedOutputPart[] | string,
    savedAtOrSegments: number | ReasoningSegment[],
    legacySavedAt?: number
): string {
    if (typeof partsOrResponse === 'string') {
        return JSON.stringify({
            response: partsOrResponse,
            segments: serializeSegments(savedAtOrSegments as ReasoningSegment[]),
            savedAt: legacySavedAt as number,
        } satisfies LegacyPersistedOutputProgress);
    }

    return JSON.stringify({
        version: 2,
        parts: normalizeOutputParts(partsOrResponse),
        savedAt: savedAtOrSegments as number,
    } satisfies PersistedOutputProgress);
}

/** Serialize the old reasoning-only progress shape for compatibility with existing callers. */
export function serializeReasoningProgress(segments: ReasoningSegment[], savedAt: number): string {
    return JSON.stringify({
        segments: serializeSegments(segments),
        savedAt,
    });
}

function serializeSegments(segments: ReasoningSegment[]): ReasoningSegment[] {
    return segments
        .filter((segment) => typeof segment.content === 'string' && segment.content.trim())
        .map((segment) => ({
            content: segment.content,
            ...(isValidTimestamp(segment.startedAt) ? { startedAt: segment.startedAt } : {}),
            ...(isValidTimestamp(segment.endedAt) ? { endedAt: segment.endedAt } : {}),
            ...(isValidTimestamp(segment.durationMs)
                ? { durationMs: Math.round(segment.durationMs) }
                : {}),
            ...(isValidTimestamp(segment.textOffset)
                ? { textOffset: Math.round(segment.textOffset) }
                : {}),
        }));
}

export function parsePersistedOutputParts(
    raw: string | null | undefined
): PersistedOutputPart[] | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const record = parsed as { version?: unknown; parts?: unknown };
        if (record.version !== 2 || !Array.isArray(record.parts)) return null;
        const parts = normalizeOutputParts(record.parts);
        return parts.length > 0 ? parts : null;
    } catch {
        return null;
    }
}

export function parseInterruptedOutputProgress(
    raw: string | null | undefined
): ParsedOutputProgress | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const record = parsed as {
            version?: unknown;
            parts?: unknown;
            response?: unknown;
            segments?: unknown;
            savedAt?: unknown;
        };
        if (!isValidTimestamp(record.savedAt)) return null;

        if (record.version === 2 && Array.isArray(record.parts)) {
            return {
                version: 2,
                parts: restoreInterruptedOutputParts(record.parts, record.savedAt),
                savedAt: record.savedAt,
            };
        }

        if (typeof record.response === 'string' && Array.isArray(record.segments)) {
            return {
                response: record.response,
                segments: restoreInterruptedSegments(record.segments, record.savedAt),
                savedAt: record.savedAt,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export function parseInterruptedReasoningProgress(
    raw: string | null | undefined
): ReasoningSegment[] {
    if (!raw) return [];

    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return [];
        const record = parsed as {
            segments?: unknown;
            savedAt?: unknown;
            version?: unknown;
            parts?: unknown;
        };
        if (!isValidTimestamp(record.savedAt)) return [];
        if (record.version === 2 && Array.isArray(record.parts)) {
            return getReasoningSegmentsFromOutputParts(
                restoreInterruptedOutputParts(record.parts, record.savedAt)
            );
        }
        if (!Array.isArray(record.segments)) return [];
        return restoreInterruptedSegments(record.segments, record.savedAt);
    } catch {
        return [];
    }
}

function restoreInterruptedOutputParts(raw: unknown[], savedAt: number): PersistedOutputPart[] {
    return normalizeOutputParts(raw).map((part) => {
        if (part.type !== 'reasoning' || part.endedAt !== undefined) return part;
        return {
            ...part,
            ...(part.startedAt !== undefined ? { endedAt: savedAt } : {}),
        };
    });
}

function restoreInterruptedSegments(raw: unknown[], savedAt: number): ReasoningSegment[] {
    return raw.flatMap((value): ReasoningSegment[] => {
        if (!value || typeof value !== 'object') return [];
        const segment = value as {
            content?: unknown;
            startedAt?: unknown;
            endedAt?: unknown;
            textOffset?: unknown;
        };
        if (
            typeof segment.content !== 'string' ||
            !segment.content.trim() ||
            !isValidTimestamp(segment.startedAt) ||
            (segment.endedAt !== undefined && !isValidTimestamp(segment.endedAt))
        ) {
            return [];
        }
        const endedAt = segment.endedAt ?? savedAt;
        if (endedAt < segment.startedAt) return [];
        return [
            {
                content: segment.content,
                startedAt: segment.startedAt,
                endedAt,
                ...(isValidTimestamp(segment.textOffset)
                    ? { textOffset: Math.round(segment.textOffset) }
                    : {}),
            },
        ];
    });
}

function isValidTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
