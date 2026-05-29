import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildPageMarkdown,
    parseWebFetchRequest,
} from '@/services/BuiltInToolService/tools/webFetch/helper';

describe('parseWebFetchRequest', () => {
    it('rejects non-http URL schemes before fetching', () => {
        setLocale('en-US');
        expect(() =>
            parseWebFetchRequest({
                url: 'vbscript:alert(1)',
                mode: 'page_markdown',
                maxChars: 1000,
            })
        ).toThrow('WebFetch tool only supports http:// and https:// URLs.');
    });

    it('rejects IPv4-mapped IPv6 hosts for private network addresses', () => {
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

    it('allows IPv4-mapped IPv6 hosts for public addresses', () => {
        const request = parseWebFetchRequest({
            url: 'https://[::ffff:8.8.8.8]/dns-query',
            mode: 'page_markdown',
            maxChars: 1000,
        });

        expect(request.url.hostname).toBe('[::ffff:808:808]');
    });
});

describe('buildPageMarkdown', () => {
    it('removes dangerous resource URL schemes while preserving safe absolute links', () => {
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
});
