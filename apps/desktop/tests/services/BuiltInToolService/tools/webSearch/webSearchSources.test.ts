import { describe, expect, it } from 'vitest';

import {
    webSearchHostname,
    webSearchSiteName,
} from '@/services/BuiltInToolService/tools/webSearch/sources';
import {
    isExternalHttpUrl,
    normalizeCitationUrl,
} from '@/views/SearchView/components/WebSearch/citations';

describe('user sees readable search source names', () => {
    it('user sees www stripped and the raw value kept for invalid urls', () => {
        expect(webSearchHostname('https://www.example.com/a')).toBe('example.com');
        expect(webSearchHostname('not a url')).toBe('not a url');
    });

    it('user sees a human site name derived from the hostname', () => {
        expect(webSearchSiteName('https://developer.mozilla.org/en-US')).toBe('mozilla');
        expect(webSearchSiteName('https://cctv.cn/news')).toBe('cctv');
    });
});

describe('user sees citations matched to the pages they came from', () => {
    it('user sees protocol, www, trailing slash and hash ignored when matching', () => {
        const expected = normalizeCitationUrl('https://example.com/a/b');
        expect(normalizeCitationUrl('http://example.com/a/b')).toBe(expected);
        expect(normalizeCitationUrl('https://www.example.com/a/b/')).toBe(expected);
        expect(normalizeCitationUrl('https://example.com/a/b#section')).toBe(expected);
        expect(normalizeCitationUrl('//example.com/a/b')).toBe(expected);
    });

    it('user sees query strings kept distinct', () => {
        expect(normalizeCitationUrl('https://example.com/a?id=1')).not.toBe(
            normalizeCitationUrl('https://example.com/a?id=2')
        );
    });

    it('user sees only external http links treated as citation candidates', () => {
        expect(isExternalHttpUrl('https://example.com')).toBe(true);
        expect(isExternalHttpUrl('//example.com')).toBe(true);
        expect(isExternalHttpUrl('#section')).toBe(false);
        expect(isExternalHttpUrl('/relative')).toBe(false);
        expect(isExternalHttpUrl('mailto:a@b.c')).toBe(false);
    });
});
