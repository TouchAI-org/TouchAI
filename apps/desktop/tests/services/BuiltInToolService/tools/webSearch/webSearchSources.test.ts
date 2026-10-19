import { describe, expect, it } from 'vitest';

import {
    parseWebSearchSources,
    serializeWebSearchSources,
    webSearchHostname,
    webSearchSiteName,
    type WebSearchSourcesPayload,
} from '@/services/BuiltInToolService/tools/webSearch/sources';
import {
    isExternalHttpUrl,
    normalizeCitationUrl,
} from '@/views/SearchView/components/WebSearch/citations';

const payload: WebSearchSourcesPayload = {
    query: 'DeepSeek V4',
    provider: 'deepseek',
    status: 'done',
    sources: [
        {
            id: 'deepseek-1',
            index: 1,
            title: 'DeepSeek V4 model released',
            url: 'https://example.com/deepseek-v4',
            snippet: 'Model-facing summary',
            siteName: 'Example News',
            favicon: 'https://example.com/favicon.ico',
            score: 2.4,
            authority: 3,
        },
    ],
};

describe('web search sources payload', () => {
    it('round-trips through the attachment identifier', () => {
        expect(parseWebSearchSources(serializeWebSearchSources(payload))).toEqual(payload);
    });

    it('ignores identifiers that are not search payloads', () => {
        expect(parseWebSearchSources('file:abc')).toBeNull();
        expect(parseWebSearchSources('web-search-sources:not-json')).toBeNull();
        expect(parseWebSearchSources('web-search-sources:{"sources":"nope"}')).toBeNull();
    });
});

describe('web search source naming', () => {
    it('strips www and falls back to the raw value for invalid urls', () => {
        expect(webSearchHostname('https://www.example.com/a')).toBe('example.com');
        expect(webSearchHostname('not a url')).toBe('not a url');
    });

    it('derives a human site name from the hostname', () => {
        expect(webSearchSiteName('https://developer.mozilla.org/en-US')).toBe('mozilla');
        expect(webSearchSiteName('https://cctv.cn/news')).toBe('cctv');
    });
});

describe('citation url matching', () => {
    it('ignores protocol, www, trailing slash and hash', () => {
        const expected = normalizeCitationUrl('https://example.com/a/b');
        expect(normalizeCitationUrl('http://example.com/a/b')).toBe(expected);
        expect(normalizeCitationUrl('https://www.example.com/a/b/')).toBe(expected);
        expect(normalizeCitationUrl('https://example.com/a/b#section')).toBe(expected);
        expect(normalizeCitationUrl('//example.com/a/b')).toBe(expected);
    });

    it('keeps query strings distinct', () => {
        expect(normalizeCitationUrl('https://example.com/a?id=1')).not.toBe(
            normalizeCitationUrl('https://example.com/a?id=2')
        );
    });

    it('only treats external http links as citation candidates', () => {
        expect(isExternalHttpUrl('https://example.com')).toBe(true);
        expect(isExternalHttpUrl('//example.com')).toBe(true);
        expect(isExternalHttpUrl('#section')).toBe(false);
        expect(isExternalHttpUrl('/relative')).toBe(false);
        expect(isExternalHttpUrl('mailto:a@b.c')).toBe(false);
    });
});
