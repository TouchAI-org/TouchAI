// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelInfo } from './types';
import { normalizeUpstreamModelMetadata } from './upstreamMetadata';

/**
 * 把上游 `/models` 的单个条目转成 `ModelInfo`。
 *
 * 各 driver 的 schema 只负责各自确认存在的字段；能力字段统一交给
 * `normalizeUpstreamModelMetadata` 嗅探，避免 12 个适配器各写一份。
 */
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
