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
