import { describe, expect, it } from 'vitest';

import type { SearchProviderId, SearchSettingsConfig } from '@/app/api/settings/tools';
import { DEFAULT_SEARCH_SETTINGS } from '@/app/api/settings/tools';
import type { WebSearchRequest } from '@/modules/tools/builtin/web-search/helper';
import {
    fuseSearchResults,
    normalizeResultUrl,
    resolveSearchProviders,
} from '@/modules/tools/builtin/web-search/routing';

function settings(overrides: Partial<SearchSettingsConfig> = {}): SearchSettingsConfig {
    return {
        ...DEFAULT_SEARCH_SETTINGS,
        providers: Object.fromEntries(
            Object.entries(DEFAULT_SEARCH_SETTINGS.providers).map(([id, config]) => [
                id,
                { ...config, enabled: true, apiKey: config.apiKey || 'test-key' },
            ])
        ) as SearchSettingsConfig['providers'],
        ...overrides,
    };
}

function request(overrides: Partial<WebSearchRequest> = {}): WebSearchRequest {
    return {
        query: 'q',
        provider: 'auto',
        intent: 'general',
        language: 'any',
        mode: 'balanced',
        domains: [],
        excludeDomains: [],
        maxResults: 6,
        timeoutMs: 15_000,
        ...overrides,
    };
}

describe('user lets the source capability pick a provider', () => {
    it('user gets the Chinese community engine for community sources', () => {
        const plan = resolveSearchProviders(
            request({ source: 'community', language: 'zh' }),
            settings()
        );
        expect(plan[0]).toBe('zhihu');
    });

    it('user gets the scholarly index for academic sources', () => {
        const plan = resolveSearchProviders(request({ source: 'academic' }), settings());
        expect(plan[0]).toBe('openalex');
    });

    it('user gets the code host for code sources', () => {
        const plan = resolveSearchProviders(request({ source: 'code' }), settings());
        expect(plan[0]).toBe('github');
    });

    it('user gets the realtime engine for breaking sources', () => {
        const plan = resolveSearchProviders(
            request({ source: 'realtime', language: 'en' }),
            settings()
        );
        expect(plan[0]).toBe('grok');
    });

    it('user falls back to the default provider when the preferred one is disabled', () => {
        const config = settings({ defaultProvider: 'anysearch' });
        config.providers.zhihu.enabled = false;
        config.providers.yuanbao.enabled = false;
        config.providers.deepseek.enabled = false;
        config.providers.grok.enabled = false;

        const plan = resolveSearchProviders(request({ source: 'community' }), config);
        expect(plan[0]).toBe('anysearch');
    });

    it('user disables community specialists and gets the next Chinese engine before a general engine', () => {
        const config = settings();
        config.providers.zhihu.enabled = false;
        config.providers.yuanbao.enabled = false;
        expect(resolveSearchProviders(request({ source: 'community' }), config)[0]).toBe(
            'deepseek'
        );
    });

    it('user disables academic engines and gets a general engine instead of an unrelated default', () => {
        const config = settings({ defaultProvider: 'github', fallbackEnabled: false });
        for (const provider of [
            'openalex',
            'semantic_scholar',
            'tinyfish',
            'anysearch',
            'keenable',
        ] as const) {
            config.providers[provider].enabled = false;
        }
        expect(resolveSearchProviders(request({ source: 'academic' }), config)[0]).toBe('tavily');
    });

    it('user gets the engine named by providerOptions even when provider is auto', () => {
        const plan = resolveSearchProviders(
            request({ providerOptions: { serper: { searchType: 'news' } } }),
            settings()
        );
        expect(plan[0]).toBe('serper');
    });

    it('user gets the priority order when that strategy is selected', () => {
        const config = settings({
            routingStrategy: 'priority',
            providerPriority: ['keenable', 'github', 'anysearch'],
        });
        expect(resolveSearchProviders(request(), config)[0]).toBe('keenable');
    });

    it('user gets their source route ahead of an unrelated legacy intent route', () => {
        const config = settings({
            intentRoutes: { ...DEFAULT_SEARCH_SETTINGS.intentRoutes, general: 'anysearch' },
            sourceRoutes: { ...DEFAULT_SEARCH_SETTINGS.sourceRoutes, community: 'yuanbao' },
        });
        expect(resolveSearchProviders(request({ source: 'community' }), config)[0]).toBe('yuanbao');
    });

    it('user gets source-routed engines in order when fusion is enabled', () => {
        const config = settings({
            routingStrategy: 'capability',
            parallelProviders: true,
            sourceRoutes: { ...DEFAULT_SEARCH_SETTINGS.sourceRoutes, community: 'yuanbao' },
        });
        const plan = resolveSearchProviders(
            request({ source: 'community', language: 'zh' }),
            config
        );
        expect(plan[0]).toBe('yuanbao');
        expect(plan[1]).toBe('zhihu');
    });

    it('user gets their default broad engine when general capability is requested', () => {
        expect(
            resolveSearchProviders(
                request({ source: 'general' }),
                settings({ defaultProvider: 'exa' })
            )[0]
        ).toBe('exa');
    });

    it('user gets a Chinese broad engine ahead of the default for Chinese general discovery', () => {
        expect(
            resolveSearchProviders(request({ source: 'general', language: 'zh' }), settings())[0]
        ).toBe('yuanbao');
    });

    it('user keeps a fixed default when capability routing is switched off', () => {
        expect(
            resolveSearchProviders(
                request({ source: 'academic' }),
                settings({ routingStrategy: 'manual', defaultProvider: 'exa' })
            )[0]
        ).toBe('exa');
    });

    it('user gets the disabled explicit engine skipped for the intent route', () => {
        const config = settings({ defaultProvider: 'semantic_scholar' });
        config.providers.semantic_scholar.enabled = false;

        const plan = resolveSearchProviders(
            request({ provider: 'semantic_scholar', intent: 'academic' }),
            config
        );
        expect(plan[0]).toBe('openalex');
    });
});

function result(url: string, title: string, snippet?: string) {
    return { title, url, snippet, source: 'Example' };
}

describe('user searches several engines at once', () => {
    it('user sees duplicate URLs merged and shared hits ranked first', () => {
        const fused = fuseSearchResults(
            [
                {
                    provider: 'keenable' as SearchProviderId,
                    results: [
                        result('https://a.com/x', 'A', 'short'),
                        result('https://b.com/', 'B'),
                    ],
                },
                {
                    provider: 'zhihu' as SearchProviderId,
                    results: [result('https://a.com/x/', 'A rich', 'a much longer snippet')],
                },
            ],
            10
        );

        expect(fused).toHaveLength(2);
        expect(fused[0]?.url).toContain('a.com');
        expect(fused[0]?.snippet).toBe('a much longer snippet');
    });

    it('user sees query parameters kept but fragments and trailing slashes normalized', () => {
        expect(normalizeResultUrl('https://Example.com/a/?q=1#top')).toBe(
            'https://example.com/a?q=1'
        );
    });

    it('user keeps distinct case-sensitive paths and query values when merging results', () => {
        expect(
            fuseSearchResults(
                [
                    { provider: 'exa', results: [result('https://example.com/Case?token=A', 'A')] },
                    {
                        provider: 'keenable',
                        results: [result('https://example.com/case?token=a', 'B')],
                    },
                ],
                10
            )
        ).toHaveLength(2);
    });

    it('user keeps full content when another engine returns a longer snippet for the same page', () => {
        const fused = fuseSearchResults(
            [
                {
                    provider: 'exa',
                    results: [
                        { ...result('https://example.com/a', 'A', 'short'), content: 'Full page' },
                    ],
                },
                {
                    provider: 'keenable',
                    results: [result('https://example.com/a', 'A', 'longer snippet')],
                },
            ],
            10
        );
        expect(fused[0]).toMatchObject({ snippet: 'longer snippet', content: 'Full page' });
    });
});
