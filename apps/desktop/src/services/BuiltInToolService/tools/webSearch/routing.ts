import type {
    SearchProviderId,
    SearchSettingsConfig,
    SearchSource,
} from '@services/SettingsService/domain';

import type { WebSearchRequest, WebSearchResult } from './helper';
import { getAvailableSearchProviders } from './providers/adapters';

/**
 * 能力路由表：只看“需要什么来源”，不看引擎品牌。
 * 顺序即优先级；未启用的会被 resolveSearchProviders 过滤。
 */
export const SEARCH_SOURCE_PRIORITY: Record<SearchSource, SearchProviderId[]> = {
    general: [
        'anysearch',
        'keenable',
        'tavily',
        'exa',
        'brave',
        'firecrawl',
        'serper',
        'tinyfish',
        'doubao',
        'qianfan',
    ],
    news: [
        'brave',
        'yuanbao',
        'grok',
        'tavily',
        'serper',
        'tinyfish',
        'doubao',
        'qianfan',
        'anysearch',
    ],
    community: ['zhihu', 'yuanbao', 'anysearch', 'deepseek'],
    academic: ['openalex', 'semantic_scholar', 'tinyfish', 'anysearch'],
    code: ['github', 'anysearch', 'keenable'],
    official: ['keenable', 'yuanbao', 'brave', 'doubao', 'qianfan', 'anysearch'],
    realtime: ['grok', 'yuanbao', 'brave', 'anysearch'],
};

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
    const available = getAvailableSearchProviders(settings).filter(
        (provider) => provider !== 'auto'
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
    if (
        !hasRequested &&
        (settings.routingStrategy === 'priority' || settings.routingStrategy === 'parallel')
    ) {
        settings.providerPriority.forEach(push);
    } else if (
        !hasRequested &&
        (settings.routingStrategy === 'manual' || settings.routingStrategy === 'model')
    ) {
        push(settings.defaultProvider);
    } else if (!hasRequested && settings.routingStrategy === 'intent') {
        push(settings.intentRoutes[request.intent]);
        push(settings.defaultProvider);
    } else if (!hasRequested) {
        // capability：先尊重用户为意图/来源指定的一级路由，再回落到能力表。
        const intentRoute = settings.intentRoutes[request.intent];
        if (!request.source && intentRoute !== 'auto') {
            push(intentRoute);
        }
        if (request.source) {
            const sourceRoute = settings.sourceRoutes[request.source];
            if (sourceRoute !== 'auto') {
                push(sourceRoute);
            }
            if (request.source !== 'general') {
                if (request.language === 'zh' && request.source === 'news') push('yuanbao');
                SEARCH_SOURCE_PRIORITY[request.source].forEach(push);
            }
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
            settings.routingStrategy === 'parallel' ||
            (settings.parallelProviders && request.mode === 'deep'))
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

    return [...merged.values()]
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return right.providers.length - left.providers.length;
        })
        .slice(0, maxResults)
        .map((entry) => entry.result);
}
