import { normalizeOptionalString, truncateText } from '@/utils/text';

import type { WebSearchResult } from '../helper';
import { nativeSearchOptions, resultLimit, setSearchParams } from './common';
import { createSearchProviderAdapter } from './define';
import { SearchProviderCapabilityError } from './types';

export const githubAdapter = createSearchProviderAdapter({
    id: 'github',
    async search({ request, settings, signal, fetchJson }) {
        const { searchType = 'repositories', ...options } = nativeSearchOptions(request, 'github');
        if (
            !['repositories', 'issues', 'code', 'commits', 'users', 'topics'].includes(
                String(searchType)
            )
        )
            throw new Error('Unsupported GitHub searchType.');
        const apiKey = settings.providers.github.apiKey.trim();
        if (searchType === 'code' && !apiKey)
            throw new SearchProviderCapabilityError(
                'GitHub code search requires a token. Configure one in Search settings.'
            );
        const searchTypeValue = String(searchType);
        const url = new URL(`https://api.github.com/search/${searchTypeValue}`);
        url.searchParams.set('q', request.query);
        url.searchParams.set('per_page', String(resultLimit(request, 100)));
        setSearchParams(url, options);

        const payload = await fetchJson(url, signal, {
            headers: {
                Accept: 'application/vnd.github+json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
        });
        const items =
            payload && typeof payload === 'object' ? (payload as { items?: unknown }).items : null;
        if (!Array.isArray(items)) {
            return [];
        }

        return items
            .map((item): WebSearchResult | null => {
                if (!item || typeof item !== 'object') {
                    return null;
                }
                const record = item as Record<string, unknown>;
                const title =
                    normalizeOptionalString(record.full_name) ??
                    normalizeOptionalString(record.title) ??
                    normalizeOptionalString(record.name) ??
                    normalizeOptionalString(record.login) ??
                    normalizeOptionalString(record.sha);
                const url =
                    normalizeOptionalString(record.html_url) ??
                    (searchTypeValue === 'topics' && title
                        ? `https://github.com/topics/${encodeURIComponent(title)}`
                        : undefined);
                if (!title || !url) {
                    return null;
                }

                const commit =
                    record.commit && typeof record.commit === 'object'
                        ? (record.commit as Record<string, unknown>)
                        : {};
                const description =
                    normalizeOptionalString(record.description) ??
                    normalizeOptionalString(record.body) ??
                    normalizeOptionalString(commit.message) ??
                    '';
                const stars =
                    typeof record.stargazers_count === 'number'
                        ? `Stars: ${record.stargazers_count}. `
                        : '';
                return {
                    title,
                    url,
                    snippet: `${stars}${truncateText(description, 600)}`.trim(),
                    source: 'GitHub',
                    ...(request.includeContent && description ? { content: description } : {}),
                };
            })
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
