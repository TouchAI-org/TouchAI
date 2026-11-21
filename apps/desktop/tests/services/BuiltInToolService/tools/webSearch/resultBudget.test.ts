import { describe, expect, it } from 'vitest';

import {
    formatWebSearchResults,
    WEB_SEARCH_EMBEDDED_CONTENT_MAX_CHARS,
    type WebSearchRequest,
} from '@/modules/tools/builtin/web-search/helper';

const request: WebSearchRequest = {
    query: 'budget',
    provider: 'auto',
    intent: 'general',
    language: 'any',
    mode: 'balanced',
    domains: [],
    excludeDomains: [],
    maxResults: 10,
    timeoutMs: 15_000,
};

describe('given results that carry both details and full text', () => {
    it('user never receives more than the per-result budget for one result', () => {
        const result = formatWebSearchResults(request, [
            {
                title: 'Expensive',
                url: 'https://example.test/1',
                source: 'Fixture',
                details: { blob: 'D'.repeat(WEB_SEARCH_EMBEDDED_CONTENT_MAX_CHARS) },
                content: 'C'.repeat(WEB_SEARCH_EMBEDDED_CONTENT_MAX_CHARS),
            },
        ]);
        expect(result).toContain('D'.repeat(100));
        expect(result).not.toContain('C'.repeat(100));
        expect(result).toContain('Content omitted');
        expect(result.length).toBeLessThan(WEB_SEARCH_EMBEDDED_CONTENT_MAX_CHARS + 2_000);
    });

    it('user still gets text for a later result after an expensive one', () => {
        const result = formatWebSearchResults(request, [
            {
                title: 'Expensive',
                url: 'https://example.test/1',
                source: 'Fixture',
                details: { blob: 'D'.repeat(WEB_SEARCH_EMBEDDED_CONTENT_MAX_CHARS) },
                content: 'C'.repeat(WEB_SEARCH_EMBEDDED_CONTENT_MAX_CHARS),
            },
            {
                title: 'Cheap',
                url: 'https://example.test/2',
                source: 'Fixture',
                content: 'later evidence',
            },
        ]);
        expect(result).toContain('later evidence');
    });
});
