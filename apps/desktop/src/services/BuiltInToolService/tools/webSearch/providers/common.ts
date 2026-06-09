import { normalizeOptionalString } from '@/utils/text';

import type { WebSearchRequest, WebSearchResult } from '../helper';

export function resultLimit(request: WebSearchRequest): number {
    return Math.max(1, Math.min(10, request.maxResults));
}

export function readResultItems(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
        return payload;
    }
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const record = payload as Record<string, unknown>;
    for (const key of ['results', 'data', 'items']) {
        const value = record[key];
        if (Array.isArray(value)) {
            return value;
        }
        if (value && typeof value === 'object') {
            const nested = value as Record<string, unknown>;
            for (const nestedKey of ['results', 'items']) {
                const nestedValue = nested[nestedKey];
                if (Array.isArray(nestedValue)) {
                    return nestedValue;
                }
            }
        }
    }
    return [];
}

export function resultFromGenericItem(item: unknown, source: string): WebSearchResult | null {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const record = item as Record<string, unknown>;
    const title =
        normalizeOptionalString(record.title) ??
        normalizeOptionalString(record.name) ??
        normalizeOptionalString(record.display_name);
    const url =
        normalizeOptionalString(record.url) ??
        normalizeOptionalString(record.link) ??
        normalizeOptionalString(record.href);
    if (!title || !url) {
        return null;
    }
    const snippet =
        normalizeOptionalString(record.snippet) ??
        normalizeOptionalString(record.description) ??
        normalizeOptionalString(record.content) ??
        normalizeOptionalString(record.text) ??
        normalizeOptionalString(record.abstract);
    return { title, url, snippet, source };
}

export function recencyStartDate(recencyDays: number | undefined): string | undefined {
    if (recencyDays === undefined || !Number.isFinite(recencyDays) || recencyDays < 1) {
        return undefined;
    }
    const date = new Date(Date.now() - recencyDays * 24 * 60 * 60 * 1000);
    return date.toISOString();
}
