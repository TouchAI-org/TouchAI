// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelInfo } from './types';
import { normalizeUpstreamModelCapabilities } from './upstreamMetadata';

/** 把上游 `/models` 条目转成 `ModelInfo`；能力字段统一交给 `normalizeUpstreamModelCapabilities`。 */
export function toModelInfo(
    raw: unknown,
    { id, name }: { id: string; name?: string | null }
): ModelInfo {
    const capabilities = normalizeUpstreamModelCapabilities(raw);

    return {
        id,
        name: name || id,
        ...(capabilities ? { capabilities } : {}),
    };
}
