// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageTrendPoint } from '@database/queries/usageStats';

/**
 * Baseline days are the durable part of a day after detailed turns were cleared.
 * Archive rows are only a fallback for legacy days that have neither a baseline
 * nor any live detail; adding them again would double-count a rolled-up day.
 */
export function mergeUsageTrendSources(
    live: readonly UsageTrendPoint[],
    baseline: readonly UsageTrendPoint[],
    archive: readonly UsageTrendPoint[]
): UsageTrendPoint[] {
    const merged = new Map<string, UsageTrendPoint>();
    const add = (point: UsageTrendPoint) => {
        const current = merged.get(point.key);
        if (!current) {
            merged.set(point.key, {
                ...point,
                segments: point.segments.map((segment) => ({ ...segment })),
            });
            return;
        }
        current.requests += point.requests;
        current.tokens += point.tokens;
        current.costMicros += point.costMicros;
        current.segments.push(...point.segments.map((segment) => ({ ...segment })));
    };

    live.forEach(add);
    baseline.forEach(add);

    const present = new Set(merged.keys());
    archive.forEach((point) => {
        if (!present.has(point.key)) add(point);
    });

    return [...merged.values()].sort((left, right) => left.key.localeCompare(right.key));
}
