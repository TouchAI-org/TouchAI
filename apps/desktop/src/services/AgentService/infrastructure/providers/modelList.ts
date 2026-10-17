// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelInfo } from './types';
import { normalizeUpstreamModelMetadata } from './upstreamMetadata';

/** 把上游 `/models` 条目转成 `ModelInfo`；能力字段统一交给 `normalizeUpstreamModelMetadata`。 */
export function toModelInfo(
    raw: unknown,
    { id, name }: { id: string; name?: string | null }
): ModelInfo {
    const metadata = normalizeUpstreamModelMetadata(raw);

    return {
        id,
        name: name || id,
        ...(metadata ? { metadata } : {}),
    };
}
