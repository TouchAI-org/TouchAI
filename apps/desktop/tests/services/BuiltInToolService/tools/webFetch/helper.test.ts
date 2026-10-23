import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildPageMarkdown,
    extractHtmlContent,
    formatFetchResult,
    parseWebFetchRequest,
} from '@/services/BuiltInToolService/tools/webFetch/helper';

describe('user asks the assistant to read a URL', () => {
    it('user sees non-http schemes rejected before fetching', () => {
        setLocale('en-US');
        expect(() =>
            parseWebFetchRequest({
                url: 'vbscript:alert(1)',
                mode: 'page_markdown',
                maxChars: 1000,
            })
        ).toThrow('WebFetch tool only supports http:// and https:// URLs.');
    });

    it('user sees IPv4-mapped IPv6 private hosts rejected', () => {
        setLocale('en-US');
        const privateMappedHosts = [
            'http://[::ffff:0.0.0.0]/',
            'http://[::ffff:10.0.0.1]/',
            'http://[::ffff:127.0.0.1]/',
            'http://[::ffff:169.254.1.1]/',
            'http://[::ffff:172.16.0.1]/',
            'http://[::ffff:192.168.0.1]/',
        ];

        for (const url of privateMappedHosts) {
            expect(() =>
                parseWebFetchRequest({
                    url,
                    mode: 'page_markdown',
                    maxChars: 1000,
                })
            ).toThrow(
                'WebFetch tool blocks localhost, private-network and single-label hostnames.'
            );
        }
    });

    it('user sees IPv4-mapped IPv6 public hosts allowed', () => {
        const request = parseWebFetchRequest({
            url: 'https://[::ffff:8.8.8.8]/dns-query',
            mode: 'page_markdown',
            maxChars: 1000,
        });

        expect(request.url.hostname).toBe('[::ffff:808:808]');
    });
});

describe('user gets readable text from a fetched page', () => {
    it('user sees dangerous resource URL schemes removed while safe absolute links stay', () => {
        const markdown = buildPageMarkdown(
            [
                '<a href="vbscript:alert(1)">script link</a>',
                '<a href=" JAVASCRIPT:alert(1)">javascript link</a>',
                '<img alt="inline" src="data:text/plain;base64,SGVsbG8=">',
                '<a href="/docs">docs</a>',
            ].join(''),
            'https://example.com/base/page'
        );

        expect(markdown).not.toContain('vbscript:');
        expect(markdown.toLowerCase()).not.toContain('javascript:');
        expect(markdown).not.toContain('data:text/plain');
        expect(markdown).toContain('[docs](https://example.com/docs)');
    });

    it('user sees meaningful lazy-loaded image URLs kept for research reports', () => {
        const markdown = buildPageMarkdown(
            [
                '<article>',
                '<h1>Product launch</h1>',
                '<img src="/placeholder.gif" data-src="/media/product-dashboard.png">',
                '<img loading="lazy" data-original="https://cdn.example.com/charts/market-share.jpg" alt="Market share chart">',
                '<img srcset="/hero-small.jpg 480w, /hero-large.jpg 1200w" alt="Hero screenshot">',
                '</article>',
            ].join(''),
            'https://example.com/news/launch'
        );

        expect(markdown).toContain(
            '![product-dashboard.png](https://example.com/media/product-dashboard.png)'
        );
        expect(markdown).toContain(
            '![Market share chart](https://cdn.example.com/charts/market-share.jpg)'
        );
        expect(markdown).toContain('![Hero screenshot](https://example.com/hero-large.jpg)');
        expect(markdown).not.toContain('/placeholder.gif');
    });
});

describe('user reads a formatted fetch result', () => {
    it('user sees original webpage image candidates included in an ordinary fetch', () => {
        const request = {
            url: new URL('https://example.com/research/report'),
            mode: 'reader',
            maxChars: 2000,
            timeoutMs: 20000,
        } as Parameters<typeof extractHtmlContent>[1];
        const payload = extractHtmlContent(
            [
                '<article>',
                '<h1>Industry report</h1>',
                '<p>Research body text.</p>',
                '<img data-src="/media/official-dashboard.png">',
                '<figure>',
                '<img srcset="/chart-small.png 480w, /chart-large.png 1200w" alt="Revenue chart">',
                '<figcaption>Official revenue chart</figcaption>',
                '</figure>',
                '</article>',
            ].join(''),
            request
        );
        const response = new Response('', { status: 200, statusText: 'OK' });

        const result = formatFetchResult(request, response, 'text/html', payload);

        expect(result).toContain('Embeddable page image candidates');
        expect(result).toContain('use relevant ones in the final answer with source attribution');
        expect(result).toContain(
            '![official-dashboard.png](https://example.com/media/official-dashboard.png)'
        );
        expect(result).toContain('![Revenue chart](https://example.com/chart-large.png)');
    });
});
