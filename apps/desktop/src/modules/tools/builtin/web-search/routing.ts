import {
    isSearchProviderReady,
    resolveSearchSourceProviders,
    SEARCH_PROVIDER_IDS,
    type SearchProviderId,
    type SearchSettingsConfig,
} from './configuration';
import type { WebSearchRequest, WebSearchResult } from './helper';

const CHINESE_PREFERENCE: SearchProviderId[] = [
    'yuanbao',
    'zhihu',
    'deepseek',
    'doubao',
    'qianfan',
];
const ENGLISH_PREFERENCE: SearchProviderId[] = ['keenable', 'brave', 'grok'];

/**
 * 一次调用要尝试的引擎顺序。
 *
 * - An explicitly selected available provider runs alone, including in fusion mode.
 * - capability（默认）先看能力路由，再看语言偏好，最后落到默认源。
 * - intent 继续沿用用户已有的 intentRoutes。
 * - priority / parallel 直接使用用户排序。
 */
export function resolveSearchProviders(
    request: WebSearchRequest,
    settings: SearchSettingsConfig
): SearchProviderId[] {
    const available = SEARCH_PROVIDER_IDS.filter(
        (provider) =>
            provider !== 'auto' && isSearchProviderReady(provider, settings.providers[provider])
    );
    const enabled = new Set(available);
    const plan: SearchProviderId[] = [];
    const push = (provider: SearchProviderId | undefined): void => {
        if (provider && provider !== 'auto' && enabled.has(provider) && !plan.includes(provider)) {
            plan.push(provider);
        }
    };

    const optionProviders = Object.keys(request.providerOptions ?? {}).filter((key) =>
        enabled.has(key as Exclude<SearchProviderId, 'auto'>)
    );
    const optionProvider: Exclude<SearchProviderId, 'auto'> | null =
        request.provider === 'auto' && optionProviders.length === 1
            ? (optionProviders[0] as Exclude<SearchProviderId, 'auto'>)
            : null;
    if (optionProvider) {
        push(optionProvider);
    }

    const requested = request.provider !== 'auto' ? request.provider : null;
    const hasRequested = requested ? enabled.has(requested) : false;
    if (hasRequested) {
        push(requested ?? undefined);
    }
    if (!hasRequested && settings.routingStrategy === 'priority') {
        settings.providerPriority.forEach(push);
    } else if (!hasRequested && settings.routingStrategy === 'manual') {
        push(settings.defaultProvider);
    } else if (!hasRequested) {
        // capability：先尊重用户为意图/来源指定的一级路由，再回落到能力表。
        const intentRoute = settings.intentRoutes[request.intent];
        if (!request.source && intentRoute !== 'auto') {
            push(intentRoute);
        }
        if (request.source) {
            resolveSearchSourceProviders(request.source, settings, request.language).forEach(push);
        }
        const languagePreference =
            request.language === 'zh'
                ? CHINESE_PREFERENCE
                : request.language === 'en'
                  ? ENGLISH_PREFERENCE
                  : [];
        languagePreference.forEach(push);
        push(settings.defaultProvider);
    }

    if (
        request.provider === 'auto' &&
        (settings.fallbackEnabled ||
            (settings.parallelProviders && settings.routingStrategy !== 'manual'))
    ) {
        settings.providerPriority.forEach(push);
        available.forEach(push);
    }

    return plan.length > 0 ? plan : available.slice(0, 1);
}

/** Remove fragments and trailing slashes while preserving case-sensitive paths and queries. */
export function normalizeResultUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        return parsed.toString();
    } catch {
        return url.trim();
    }
}

/**
 * Reciprocal Rank Fusion（k=60）。
 * 同一 URL 被多个引擎命中时分数相加，取摘要更完整的一条。
 */
export function fuseSearchResults(
    providerResults: Array<{ provider: SearchProviderId; results: WebSearchResult[] }>,
    maxResults: number
): WebSearchResult[] {
    const K = 60;
    const merged = new Map<
        string,
        { score: number; result: WebSearchResult; providers: SearchProviderId[] }
    >();

    for (const { provider, results } of providerResults) {
        const seen = new Set<string>();
        results.forEach((result, rank) => {
            const key = normalizeResultUrl(result.url);
            if (seen.has(key)) return;
            seen.add(key);
            const contribution = 1 / (K + rank + 1);
            const existing = merged.get(key);
            if (existing) {
                existing.score += contribution;
                existing.providers.push(provider);
                const existingLength = (existing.result.snippet ?? '').length;
                const nextLength = (result.snippet ?? '').length;
                const content =
                    (result.content?.length ?? 0) > (existing.result.content?.length ?? 0)
                        ? result.content
                        : existing.result.content;
                if (nextLength > existingLength) {
                    existing.result = { ...existing.result, ...result };
                }
                existing.result = { ...existing.result, content };
            } else {
                merged.set(key, { score: contribution, result, providers: [provider] });
            }
        });
    }

    const fused = [...merged.values()].sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return right.providers.length - left.providers.length;
    });
    return (maxResults > 0 ? fused.slice(0, maxResults) : fused).map((entry) => entry.result);
}
