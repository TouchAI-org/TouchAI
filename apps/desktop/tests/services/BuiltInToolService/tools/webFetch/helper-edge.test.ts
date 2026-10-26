import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildPageMarkdown,
    buildPageText,
    extractHtmlContent,
    extractReadableArticle,
    getContentType,
    readResponseText,
    validateWebFetchUrl,
    type WebFetchRequest,
} from '@/services/BuiltInToolService/tools/webFetch/helper';

/**
 * Pages on the real web are messy: they carry fragment links, blocked resource schemes on
 * images, broken percent-encoding in file names, and images with nothing to name them. Each of
 * those has to end up as something the model can read rather than as broken markdown.
 */

function createRequest(overrides: Partial<WebFetchRequest> = {}): WebFetchRequest {
    return {
        url: new URL('https://example.com/page'),
        mode: 'page_markdown',
        maxChars: 10_000,
        timeoutMs: 20_000,
        maxResponseBytes: 2_000_000,
        ...overrides,
    };
}

describe('user reads a page whose links and images are unusable', () => {
    it('user gets an in-page anchor left alone instead of resolved into an address', () => {
        const markdown = buildPageMarkdown(
            '<p><a href="#appendix">appendix</a> and <a href="#">top</a></p>',
            'https://example.com/report'
        );

        expect(markdown).toContain('[appendix](#appendix)');
        expect(markdown).toContain('[top](#)');
    });

    it('user does not get a data link kept as a link the model would treat as content', () => {
        const markdown = buildPageMarkdown(
            '<p><a href="data:text/html;base64,PHNjcmlwdD4=">payload</a></p>',
            'https://example.com/report'
        );

        expect(markdown).not.toContain('data:text/html');
        expect(markdown).toContain('payload');
    });

    it('user does not get an image with a blocked scheme kept in the markdown', () => {
        setLocale('en-US');

        const markdown = buildPageMarkdown(
            '<p>before</p><img src="#fragment" alt="Anchor image"><p>after</p>',
            'https://example.com/report'
        );

        expect(markdown).not.toContain('#fragment');
        expect(markdown).toContain('[Image: Anchor image]');
    });

    it('user gets an image srcset with a blocked scheme dropped rather than left half-written', () => {
        const markdown = buildPageMarkdown(
            '<img srcset="javascript:alert(1) 1x" alt="Blocked srcset">',
            'https://example.com/report'
        );

        expect(markdown).not.toContain('javascript:');
    });

    it('user gets an image srcset with only an anchor candidate dropped', () => {
        const markdown = buildPageMarkdown(
            '<img srcset="#fragment 1x, #other 2x" alt="Anchor srcset">',
            'https://example.com/report'
        );

        expect(markdown).not.toContain('#fragment');
    });

    it('user gets an image srcset with empty candidates ignored rather than breaking the image', () => {
        const markdown = buildPageMarkdown(
            '<img srcset=", , " alt="Empty srcset">',
            'https://example.com/report'
        );

        expect(markdown).toContain('[Image: Empty srcset]');
    });

    it('user gets a picture source with empty srcset candidates ignored', () => {
        const markdown = buildPageMarkdown(
            '<picture><source srcset=" , "><img alt="Empty picture"></picture>',
            'https://example.com/report'
        );

        expect(markdown).toContain('[Image: Empty picture]');
    });

    it('user gets an image whose file name has broken percent-encoding named safely', () => {
        const markdown = buildPageMarkdown(
            '<img src="/media/broken%ZZname.png">',
            'https://example.com/report'
        );

        // A malformed escape must not throw and lose the whole page.
        expect(markdown).toContain('media/broken%ZZname.png');
    });

    it('user gets an image with nothing to name it described as a generic image', () => {
        const markdown = buildPageMarkdown(
            '<img src="https://example.com/">',
            'https://example.com/report'
        );

        expect(markdown).toContain('![image](https://example.com/)');
    });

    it('user gets a picture whose only source is a placeholder left undescribed', () => {
        const markdown = buildPageMarkdown(
            '<picture><source srcset="/img/placeholder.gif 1x"><img alt="Real picture"></picture>',
            'https://example.com/report'
        );

        expect(markdown).not.toContain('placeholder.gif');
    });

    it('user gets a page with no body element still converted from its document root', () => {
        const markdown = buildPageMarkdown(
            '<!doctype html><html><head><title>No body</title></head></html>',
            'https://example.com/report'
        );

        expect(markdown).not.toContain('<');
    });

    it('user gets a page with no body element still read as plain text', () => {
        expect(buildPageText('<html><head></head></html>')).toBe('');
    });
});

describe('user reads a page whose article has no nameable metadata', () => {
    it('user gets an article that turndowns to nothing reported as unreadable', () => {
        // An article element whose only content is a comment produces no markdown, so the
        // reader has to give up rather than return an empty body.
        const article = extractReadableArticle(
            '<html><body><article><!-- only a comment --></article></body></html>',
            'https://example.com/empty'
        );

        expect(article).toBeNull();
    });

    it('user gets a readable article with no author, site or date left with those fields empty', () => {
        const article = extractReadableArticle(
            [
                '<html><head><title>Just a title</title></head><body><article>',
                '<p>A paragraph long enough that the readability scorer treats it as the body.</p>',
                '<p>A second paragraph so the extraction is confident about the article.</p>',
                '</article></body></html>',
            ].join(''),
            'https://example.com/article'
        );

        expect(article?.title).toBe('Just a title');
        expect(article?.byline).toBeUndefined();
        expect(article?.siteName).toBeUndefined();
        expect(article?.publishedTime).toBeUndefined();
    });
});

describe('user reads a page the model asked for in reader mode', () => {
    it('user gets reader mode falling back to markdown when the page is only a picture', () => {
        const payload = extractHtmlContent(
            '<img src="/media/chart.png" alt="Chart">',
            createRequest({ mode: 'reader' })
        );

        expect(payload.actualMode).toBe('page_markdown');
        expect(payload.content).toContain('![Chart]');
    });

    it('user gets reader mode falling back to plain text when the page is only hidden markup', () => {
        const payload = extractHtmlContent(
            '<div aria-hidden="true">nothing readable</div>',
            createRequest({ mode: 'reader' })
        );

        expect(payload.actualMode).toBe('page_text');
        expect(payload.content).toBe('');
    });
});

describe('user reads a response that arrives without the usual headers', () => {
    it('user gets the text decoded when the server sent no content type at all', async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('no header body'));
                controller.close();
            },
        });

        const payload = await readResponseText(new Response(stream));

        expect(payload.text).toBe('no header body');
        expect(payload.sourceTruncated).toBe(false);
    });

    it('user gets an empty body read as empty text instead of failing', async () => {
        const payload = await readResponseText(new Response(null));

        expect(payload.text).toBe('');
        expect(payload.sourceTruncated).toBe(false);
    });

    it('user gets a generic content type when the header is present but empty', () => {
        const response = new Response(null, { headers: { 'content-type': '' } });

        expect(getContentType(response)).toBe('application/octet-stream');
    });
});

describe('user gets an address checked before the assistant fetches it', () => {
    it('user gets an octet that cannot be a real address left to the address parser', () => {
        // The URL parser rejects these outright, so the private-range check never sees them.
        for (const address of ['http://256.1.1.1/', 'http://1.2.3.999/']) {
            expect(() => validateWebFetchUrl(new URL(address)), address).toThrow();
        }
    });

    it('user gets a non-numeric dotted host treated as an ordinary hostname', () => {
        expect(() => validateWebFetchUrl(new URL('http://1.2.3.x/'))).not.toThrow();
    });

    it('user gets a public IPv6 address accepted', () => {
        expect(() => validateWebFetchUrl(new URL('http://[2001:4860:4860::8888]/'))).not.toThrow();
    });
});

describe('user reads a page with a very long image list', () => {
    it('user gets the last srcset candidate used even when earlier ones are placeholders', () => {
        setLocale('en-US');

        const payload = extractHtmlContent(
            '<img srcset="/img/placeholder.gif 1x, /media/real.png 2x" alt="Real chart">',
            createRequest()
        );

        expect(payload.imageCandidates?.[0]).toContain('/media/real.png');
    });
});
