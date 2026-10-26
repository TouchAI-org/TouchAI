import { describe, expect, it, vi } from 'vitest';

import { setLocale, tt } from '@/i18n';
import {
    buildPageMarkdown,
    buildPageText,
    createRequestSignal,
    extractHtmlContent,
    extractReadableArticle,
    formatFetchResult,
    formatUnsupportedResponse,
    getContentType,
    isHtmlContentType,
    isTextualContentType,
    normalizeStructuredText,
    parseWebFetchRequest,
    readResponseText,
    truncateContent,
    validateWebFetchUrl,
    type WebFetchRequest,
} from '@/services/BuiltInToolService/tools/webFetch/helper';

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

function responseFrom(chunks: Uint8Array[], init: ResponseInit = {}): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });

    return new Response(stream, init);
}

describe('user gets an unsafe address refused before the assistant fetches it', () => {
    it('user is told only web addresses are supported', () => {
        setLocale('en-US');

        expect(() => validateWebFetchUrl(new URL('file:///etc/passwd'))).toThrow(
            'WebFetch tool only supports http:// and https:// URLs.'
        );
    });

    it('user is told credentials in a link are not allowed', () => {
        setLocale('en-US');

        expect(() => validateWebFetchUrl(new URL('https://user:secret@example.com/page'))).toThrow(
            'WebFetch tool does not allow embedded credentials in URLs.'
        );
    });

    it('user is told loopback addresses are blocked', () => {
        setLocale('en-US');
        const blocked = [
            'http://localhost/',
            'http://api.localhost/',
            'http://machine.local/',
            'http://machine.localdomain/',
            'http://0.0.0.0/',
            'http://10.0.0.1/',
            'http://127.0.0.1/',
            'http://169.254.1.1/',
            'http://172.16.0.1/',
            'http://192.168.0.1/',
            'http://[::1]/',
            'http://[fc00::1]/',
            'http://[fd12:3456::1]/',
            'http://[fe80::1]/',
            'http://[fe90::1]/',
            'http://[fea0::1]/',
            'http://[feb0::1]/',
        ];

        for (const address of blocked) {
            expect(
                () => validateWebFetchUrl(new URL(address)),
                `expected ${address} to be blocked`
            ).toThrow(
                'WebFetch tool blocks localhost, private-network and single-label hostnames.'
            );
        }
    });

    it('user is told a bare machine name is blocked because it usually resolves internally', () => {
        setLocale('en-US');

        expect(() => validateWebFetchUrl(new URL('http://intranet/'))).toThrow(
            'WebFetch tool blocks localhost, private-network and single-label hostnames.'
        );
    });

    it('user gets a public address accepted', () => {
        setLocale('en-US');

        expect(() => validateWebFetchUrl(new URL('https://example.com/report'))).not.toThrow();
        expect(() => validateWebFetchUrl(new URL('http://[::ffff:808:808]/'))).not.toThrow();
        expect(() => validateWebFetchUrl(new URL('http://8.8.8.8/'))).not.toThrow();
    });

    it('user is told the address is invalid when it cannot be parsed', () => {
        setLocale('en-US');

        expect(() =>
            parseWebFetchRequest({ url: 'not-a-url', mode: 'page_markdown', maxChars: 1000 })
        ).toThrow('WebFetch tool received an invalid URL: not-a-url');
    });

    it('user gets the documented defaults when the optional limits were not given', () => {
        setLocale('en-US');

        const request = parseWebFetchRequest({
            url: 'https://example.com/article',
            mode: 'reader',
            maxChars: 5000,
        });

        expect(request.timeoutMs).toBe(20_000);
        expect(request.maxResponseBytes).toBe(2_000_000);
        expect(request.mode).toBe('reader');
        expect(request.maxChars).toBe(5000);
        expect(request.url.toString()).toBe('https://example.com/article');
    });

    it('user gets the optional limits kept when they were given', () => {
        setLocale('en-US');

        const request = parseWebFetchRequest({
            url: 'https://example.com/article',
            mode: 'page_text',
            maxChars: 500,
            timeoutMs: 1000,
            maxResponseBytes: 50_000,
        });

        expect(request.timeoutMs).toBe(1000);
        expect(request.maxResponseBytes).toBe(50_000);
    });
});

describe('user gets a slow page fetch stopped or cancelled', () => {
    it('user gets the request cancelled when the page takes too long', async () => {
        setLocale('en-US');
        const { signal, cleanup } = createRequestSignal(undefined, 5);

        await new Promise((resolve) => window.setTimeout(resolve, 30));

        expect(signal.aborted).toBe(true);
        expect((signal.reason as DOMException).name).toBe('TimeoutError');
        expect((signal.reason as DOMException).message).toBe('WebFetch timed out after 5ms');

        cleanup();
    });

    it('user gets the fetch cancelled when they stop the assistant', () => {
        const upstream = new AbortController();
        const { signal, cleanup } = createRequestSignal(upstream.signal, 60_000);

        expect(signal.aborted).toBe(false);

        upstream.abort('user stopped the request');

        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe('user stopped the request');

        cleanup();
    });

    it('user gets an already-cancelled request not started at all', () => {
        const upstream = new AbortController();
        upstream.abort('already stopped');

        const { signal, cleanup } = createRequestSignal(upstream.signal, 60_000);

        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe('already stopped');

        cleanup();
    });

    it('user gets no timer or listener left behind after the fetch settles', () => {
        vi.useFakeTimers();
        try {
            const upstream = new AbortController();
            const { signal, cleanup } = createRequestSignal(upstream.signal, 1000);

            cleanup();
            vi.advanceTimersByTime(5000);
            expect(signal.aborted).toBe(false);

            // A listener left behind would still abort a signal nobody owns any more.
            upstream.abort('late abort');
            expect(signal.aborted).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('user reads a response body within limits', () => {
    it('user gets the response charset used to decode a page', async () => {
        const bytes = new TextEncoder().encode('中文标题');
        const response = responseFrom([bytes], {
            headers: { 'content-type': 'text/html; charset=utf-8' },
        });

        const payload = await readResponseText(response);

        expect(payload.text).toBe('中文标题');
        expect(payload.sourceTruncated).toBe(false);
    });

    it('user gets the text readable even when the charset in the header is unknown', async () => {
        const response = responseFrom([new TextEncoder().encode('fallback text')], {
            headers: { 'content-type': 'text/plain; charset=x-not-a-real-charset' },
        });

        const payload = await readResponseText(response);

        expect(payload.text).toBe('fallback text');
        expect(payload.sourceTruncated).toBe(false);
    });

    it('user gets a response without a stream read as whole text', async () => {
        const response = new Response('plain body text', {
            headers: { 'content-type': 'text/plain' },
        });

        const payload = await readResponseText(response);

        expect(payload.text).toBe('plain body text');
        expect(payload.sourceTruncated).toBe(false);
    });

    it('user gets a huge page cut off at the byte limit instead of exhausting memory', async () => {
        const response = responseFrom(
            [new TextEncoder().encode('a'.repeat(600)), new TextEncoder().encode('b'.repeat(600))],
            { headers: { 'content-type': 'text/html' } }
        );

        const payload = await readResponseText(response, 1_500_000, 1000);

        expect(payload.sourceTruncated).toBe(true);
        expect(payload.text).toBe('a'.repeat(600));
    });

    it('user gets a huge page cut off at the character limit before it is converted', async () => {
        const response = responseFrom([new TextEncoder().encode('a'.repeat(200))], {
            headers: { 'content-type': 'text/html' },
        });

        const payload = await readResponseText(response, 50);

        expect(payload.text).toBe('a'.repeat(50));
        expect(payload.sourceTruncated).toBe(true);
    });
});

describe('user gets a content type understood from the response headers', () => {
    it('user gets the media type without its charset parameters', () => {
        const response = new Response('', {
            headers: { 'content-type': 'Text/HTML; charset=UTF-8' },
        });

        expect(getContentType(response)).toBe('text/html');
    });

    it('user gets a generic binary type when the server sent no content type', () => {
        expect(getContentType(new Response(null))).toBe('application/octet-stream');
        expect(getContentType(new Response('', { headers: { 'content-type': '   ' } }))).toBe(
            'application/octet-stream'
        );
    });

    it('user gets a page recognised as html for both html media types', () => {
        expect(isHtmlContentType('text/html')).toBe(true);
        expect(isHtmlContentType('application/xhtml+xml')).toBe(true);
        expect(isHtmlContentType('application/json')).toBe(false);
    });

    it('user gets text formats recognised as readable and a pdf refused', () => {
        for (const contentType of [
            'text/html',
            'application/xhtml+xml',
            'application/json',
            'application/ld+json',
            'text/markdown',
            'text/x-markdown',
            'text/plain',
            'text/csv',
            'application/xml',
            'application/rss+xml',
            'image/svg+xml',
        ]) {
            expect(isTextualContentType(contentType), contentType).toBe(true);
        }

        expect(isTextualContentType('application/pdf')).toBe(false);
        expect(isTextualContentType('image/png')).toBe(false);
        expect(isTextualContentType('application/octet-stream')).toBe(false);
    });
});

describe('user gets structured data tidied up', () => {
    it('user gets json indented so the model can read the structure', () => {
        const result = normalizeStructuredText('{"a":1,"b":[2,3]}', 'application/json');

        expect(result).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    });

    it('user gets broken json kept as plain text rather than thrown away', () => {
        const result = normalizeStructuredText('{"a": 1,,}', 'application/json');

        expect(result).toBe('{"a": 1,,}');
    });

    it('user gets markdown line breaks kept while extra blank lines are trimmed', () => {
        const result = normalizeStructuredText(
            '# Title\r\n\r\n\r\n\r\nBody   \r\n',
            'text/markdown'
        );

        expect(result).toBe('# Title\n\nBody');
    });

    it('user gets plain text collapsed without losing its paragraph breaks', () => {
        const result = normalizeStructuredText(
            'para one   \n\n\n\npara two\0 with a null',
            'text/plain'
        );

        expect(result).toBe('para one\n\npara two with a null');
    });
});

describe('user gets a readable article out of a page', () => {
    it('user gets the article body with its title and author', () => {
        setLocale('en-US');

        const article = extractReadableArticle(
            [
                '<html><head><title>Deep dive</title></head><body>',
                '<nav>site navigation</nav>',
                '<article>',
                '<h1>Deep dive</h1>',
                '<p class="lead">This is the opening paragraph of the article body.</p>',
                '<p>This is the second paragraph with enough text to be considered content by the readability scorer.</p>',
                '<p>And a third paragraph so the parser treats the block as the main article text.</p>',
                '</article>',
                '<footer>site footer</footer>',
                '</body></html>',
            ].join(''),
            'https://example.com/article'
        );

        expect(article).not.toBeNull();
        expect(article?.actualMode).toBe('reader');
        expect(article?.title).toBe('Deep dive');
        expect(article?.content).toContain('opening paragraph');
        expect(article?.content).not.toContain('site navigation');
        expect(article?.content).not.toContain('site footer');
        expect(article?.bodyTruncated).toBe(false);
        expect(article?.sourceTruncated).toBe(false);
    });

    it('user gets no article when the page has nothing readable', () => {
        expect(extractReadableArticle('<div></div>', 'https://example.com/empty')).toBeNull();
    });

    it('user gets the relative links of a readable article resolved', () => {
        const article = extractReadableArticle(
            [
                '<html><head><title>Guide</title></head><body><article>',
                '<h1>Guide</h1>',
                '<p>A paragraph long enough to be treated as the main article body by the reader.</p>',
                '<p>Another paragraph that also carries enough words for the readability heuristics.</p>',
                '<p>See <a href="/docs/setup">the setup guide</a> for the details.</p>',
                '</article></body></html>',
            ].join(''),
            'https://example.com/articles/guide'
        );

        expect(article?.content).toContain('[the setup guide](https://example.com/docs/setup)');
    });
});

describe('user gets a page converted to the requested shape', () => {
    it('user gets the page rendered as markdown with headings and links', () => {
        const markdown = buildPageMarkdown(
            '<h1>Report</h1><p>Read the <a href="/docs">docs</a>.</p>',
            'https://example.com/news/report'
        );

        expect(markdown).toContain('# Report');
        expect(markdown).toContain('[docs](https://example.com/docs)');
    });

    it('user gets navigation, forms and buttons stripped out of the markdown', () => {
        const markdown = buildPageMarkdown(
            [
                '<nav>menu</nav>',
                '<aside>sidebar</aside>',
                '<form><input value="x"><button>Submit</button></form>',
                '<main><p>Real content</p></main>',
                '<footer>legal</footer>',
                '<script>alert(1)</script>',
                '<style>.x{color:red}</style>',
                '<noscript>noscript text</noscript>',
            ].join(''),
            'https://example.com/'
        );

        expect(markdown).toContain('Real content');
        expect(markdown).not.toContain('menu');
        expect(markdown).not.toContain('sidebar');
        expect(markdown).not.toContain('Submit');
        expect(markdown).not.toContain('legal');
        expect(markdown).not.toContain('alert(1)');
        expect(markdown).not.toContain('noscript text');
        expect(markdown).not.toContain('color:red');
    });

    it('user gets the page rendered as plain text without any markup', () => {
        const text = buildPageText(
            '<p>Read the <a href="/docs">docs</a> now.</p><script>x()</script><style>.a{}</style>'
        );

        expect(text).toBe('Read the docs now.');
        expect(text).not.toContain('<');
        expect(text).not.toContain('x()');
    });

    it('user gets the document text used when the body is missing', () => {
        expect(buildPageText('<div>fragment only</div>')).toBe('fragment only');
    });

    it('user gets an image with no source described by its alt text', () => {
        const markdown = buildPageMarkdown(
            '<p>before</p><img alt="Retail sales chart"><p>after</p>',
            'https://example.com/'
        );

        expect(markdown).toContain('[Image: Retail sales chart]');
    });

    it('user gets an image with no source and no alt text left out entirely', () => {
        const markdown = buildPageMarkdown(
            '<p>before</p><img><p>after</p>',
            'https://example.com/'
        );

        expect(markdown).not.toContain('![');
        expect(markdown).toContain('before');
        expect(markdown).toContain('after');
    });

    it('user gets a figure caption used as the image label before the file name', () => {
        const markdown = buildPageMarkdown(
            '<figure><img src="/chart.png"><figcaption>Quarterly revenue</figcaption></figure>',
            'https://example.com/'
        );

        expect(markdown).toContain('![Quarterly revenue](https://example.com/chart.png)');
    });

    it('user gets an image label taken from the aria-label when there is no alt', () => {
        const markdown = buildPageMarkdown(
            '<img src="/chart.png" aria-label="Accessible chart">',
            'https://example.com/'
        );

        expect(markdown).toContain('![Accessible chart](https://example.com/chart.png)');
    });

    it('user gets an image label taken from the title attribute when there is no alt', () => {
        const markdown = buildPageMarkdown(
            '<img src="/chart.png" title="Titled chart">',
            'https://example.com/'
        );

        expect(markdown).toContain('![Titled chart](https://example.com/chart.png)');
    });

    it('user gets an image label derived from the file name when nothing else names it', () => {
        const markdown = buildPageMarkdown(
            '<img src="/media/quarterly-revenue.png">',
            'https://example.com/'
        );

        expect(markdown).toContain(
            '![quarterly-revenue.png](https://example.com/media/quarterly-revenue.png)'
        );
    });

    it('user gets markdown-breaking characters escaped out of an image label', () => {
        const markdown = buildPageMarkdown(
            '<img src="/chart.png" alt="[draft] a \\ b">',
            'https://example.com/'
        );

        expect(markdown).toContain('![draft a  b](https://example.com/chart.png)');
    });

    it('user gets a placeholder tracking pixel left out of the page', () => {
        const markdown = buildPageMarkdown(
            [
                '<p>text</p>',
                '<img src="/img/placeholder.gif">',
                '<img src="/img/spacer.png">',
                '<img src="/img/blank.gif">',
                '<img src="/img/transparent.png">',
                '<img src="/img/pixel.gif">',
                '<img src="/img/tracking.png">',
                '<img src="/img/loading.svg">',
            ].join(''),
            'https://example.com/'
        );

        expect(markdown).not.toContain('placeholder.gif');
        expect(markdown).not.toContain('spacer.png');
        expect(markdown).not.toContain('blank.gif');
        expect(markdown).not.toContain('transparent.png');
        expect(markdown).not.toContain('pixel.gif');
        expect(markdown).not.toContain('tracking.png');
        expect(markdown).not.toContain('loading.svg');
    });

    it('user gets a lazy-loaded image source preferred over a placeholder', () => {
        const markdown = buildPageMarkdown(
            '<img src="/img/placeholder.gif" data-lazy-src="/media/real-chart.png" alt="Chart">',
            'https://example.com/'
        );

        expect(markdown).toContain('![Chart](https://example.com/media/real-chart.png)');
    });

    it('user gets the largest srcset candidate used for a responsive image', () => {
        const markdown = buildPageMarkdown(
            '<img srcset="/s.jpg 200w, /m.jpg 800w, /l.jpg 2000w" alt="Photo">',
            'https://example.com/'
        );

        expect(markdown).toContain('![Photo](https://example.com/l.jpg)');
    });

    it('user gets the source element image used when the img itself has no source', () => {
        const markdown = buildPageMarkdown(
            '<picture><source srcset="/narrow.jpg 400w, /wide.jpg 1200w"><img alt="Responsive"></picture>',
            'https://example.com/'
        );

        expect(markdown).toContain('![Responsive](https://example.com/wide.jpg)');
    });

    it('user gets a dangerous image source removed rather than kept in the markdown', () => {
        const markdown = buildPageMarkdown(
            '<p>text</p><img src="javascript:alert(1)" alt="bad">',
            'https://example.com/'
        );

        expect(markdown).not.toContain('javascript:');
        expect(markdown).toContain('[Image: bad]');
    });

    it('user gets an in-page anchor left alone while other links are made absolute', () => {
        const markdown = buildPageMarkdown(
            '<p><a href="#appendix">appendix</a> and <a href="/docs">docs</a></p>',
            'https://example.com/report'
        );

        expect(markdown).toContain('[appendix](#appendix)');
        expect(markdown).toContain('[docs](https://example.com/docs)');
    });
});

describe('user gets image candidates collected from the page', () => {
    it('user gets every page image offered as a research candidate', () => {
        const payload = extractHtmlContent(
            [
                '<article>',
                '<h1>Report</h1>',
                '<img src="/media/one.png" alt="First chart">',
                '<img src="/media/two.png" alt="Second chart">',
                '</article>',
            ].join(''),
            createRequest()
        );

        expect(payload.imageCandidates).toEqual([
            '![First chart](https://example.com/media/one.png)',
            '![Second chart](https://example.com/media/two.png)',
        ]);
    });

    it('user gets at most six image candidates so the answer stays readable', () => {
        const images = Array.from(
            { length: 9 },
            (_value, index) => `<img src="/media/${index}.png" alt="Chart ${index}">`
        ).join('');

        const payload = extractHtmlContent(`<article>${images}</article>`, createRequest());

        expect(payload.imageCandidates).toHaveLength(6);
        expect(payload.imageCandidates?.[0]).toContain('/media/0.png');
        expect(payload.imageCandidates?.[5]).toContain('/media/5.png');
    });

    it('user gets the same image listed once even when the page repeats it', () => {
        const payload = extractHtmlContent(
            '<img src="/media/repeated.png" alt="Chart"><img src="/media/repeated.png" alt="Chart">',
            createRequest()
        );

        expect(payload.imageCandidates).toHaveLength(1);
    });

    it('user gets avatars, logos, icons and sprites left out of the candidates', () => {
        const payload = extractHtmlContent(
            [
                '<img src="/assets/avatar.png" alt="Avatar">',
                '<img src="/assets/logo.png" alt="Logo">',
                '<img src="/assets/icon.png" alt="Icon">',
                '<img src="/assets/sprite.png" alt="Sprite">',
                '<img src="/assets/beacon.png" alt="Beacon">',
                '<img src="/assets/gravatar.png" alt="Gravatar">',
                '<img src="/assets/analytics.png" alt="Analytics">',
                '<img src="/media/real-chart.png" alt="Real chart">',
            ].join(''),
            createRequest()
        );

        expect(payload.imageCandidates).toEqual([
            '![Real chart](https://example.com/media/real-chart.png)',
        ]);
    });

    it('user gets no candidate list at all when the page had no usable image', () => {
        const payload = extractHtmlContent('<p>only text</p>', createRequest());

        expect(payload.imageCandidates).toBeUndefined();
    });
});

describe('user gets the page converted in the mode they asked for', () => {
    it('user gets the main article only when reader mode works', () => {
        const payload = extractHtmlContent(
            [
                '<html><head><title>Analysis</title></head><body>',
                '<nav>navigation</nav>',
                '<article>',
                '<h1>Analysis</h1>',
                '<p>The main article paragraph has plenty of words so the reader keeps it as the body.</p>',
                '<p>A second substantial paragraph to make the article extraction confident.</p>',
                '</article>',
                '</body></html>',
            ].join(''),
            createRequest({ mode: 'reader' })
        );

        expect(payload.actualMode).toBe('reader');
        expect(payload.content).toContain('main article paragraph');
        expect(payload.content).not.toContain('navigation');
        expect(payload.title).toBe('Analysis');
    });

    it('user gets the whole page as markdown when reader mode finds nothing readable', () => {
        // A page whose only content is an image has no article body, so the reader gives up and
        // the whole page is converted instead.
        const payload = extractHtmlContent(
            '<img src="/media/chart.png" alt="Chart">',
            createRequest({ mode: 'reader' })
        );

        expect(payload.actualMode).toBe('page_markdown');
        expect(payload.content).toContain('![Chart](https://example.com/media/chart.png)');
        expect(payload.title).toBeUndefined();
    });

    it('user gets plain text when they asked for plain text', () => {
        const payload = extractHtmlContent(
            '<h1>Title</h1> <p>Body <strong>bold</strong></p>',
            createRequest({ mode: 'page_text' })
        );

        expect(payload.actualMode).toBe('page_text');
        expect(payload.content).toBe('Title Body bold');
        expect(payload.bodyTruncated).toBe(false);
        expect(payload.sourceTruncated).toBe(false);
    });

    it('user gets the page title shown with the markdown conversion', () => {
        const payload = extractHtmlContent(
            '<html><head><title>Quarterly review</title></head><body><p>Body text.</p></body></html>',
            createRequest()
        );

        expect(payload.actualMode).toBe('page_markdown');
        expect(payload.title).toBe('Quarterly review');
    });

    it('user gets plain text when the page converted to no markdown at all', () => {
        // An empty page has no markdown to give, so the plain-text path takes over.
        const payload = extractHtmlContent('<div>   </div>', createRequest());

        expect(payload.actualMode).toBe('page_text');
        expect(payload.content).toBe('');
    });

    it('user gets long page content cut at their limit with a note in the text', () => {
        setLocale('en-US');

        const payload = extractHtmlContent(
            `<p>${'x'.repeat(300)}</p>`,
            createRequest({ mode: 'page_text', maxChars: 100 })
        );

        expect(payload.bodyTruncated).toBe(true);
        expect(payload.content).toContain('x'.repeat(100));
        expect(payload.content).toContain('[Body truncated, 300 characters total]');
    });

    it('user gets short content left untouched with no truncation flag', () => {
        const payload = extractHtmlContent(
            '<p>short</p>',
            createRequest({ mode: 'page_text', maxChars: 5000 })
        );

        expect(payload.bodyTruncated).toBe(false);
        expect(payload.content).toBe('short');
    });

    it('user gets the truncation note counting the whole body, not the cut text', () => {
        const truncated = truncateContent('abcdefghij', 4);

        expect(truncated.bodyTruncated).toBe(true);
        expect(truncated.content.startsWith('abcd')).toBe(true);
        expect(truncated.content).toContain('10');
    });

    it('user gets content exactly at the limit left untruncated', () => {
        const truncated = truncateContent('abcd', 4);

        expect(truncated).toEqual({ content: 'abcd', bodyTruncated: false });
    });
});

describe('user reads the formatted fetch result', () => {
    it('user sees the request, final address, status and mode of the fetch', () => {
        setLocale('en-US');

        const request = createRequest({ mode: 'page_text', maxChars: 2000 });
        const response = new Response('', { status: 200, statusText: 'OK' });
        Object.defineProperty(response, 'url', { value: 'https://example.com/final' });

        const result = formatFetchResult(request, response, 'text/html', {
            content: 'Body text',
            actualMode: 'page_text',
            bodyTruncated: false,
            sourceTruncated: false,
        });

        expect(result).toContain('Web page fetch');
        expect(result).toContain('Request URL: https://example.com/page');
        expect(result).toContain('Final URL: https://example.com/final');
        expect(result).toContain('HTTP status: 200 OK');
        expect(result).toContain('Content type: text/html');
        expect(result).toContain('Request mode: page_text');
        expect(result).toContain('Actual output: page_text');
        expect(result).toContain('Body text');
    });

    it('user sees the final address fall back to the request address when the response has none', () => {
        setLocale('en-US');

        const result = formatFetchResult(
            createRequest(),
            new Response('', { status: 200, statusText: 'OK' }),
            'text/html',
            {
                content: 'Body',
                actualMode: 'page_markdown',
                bodyTruncated: false,
                sourceTruncated: false,
            }
        );

        expect(result).toContain('Final URL: https://example.com/page');
    });

    it('user sees the article metadata included when the reader found it', () => {
        setLocale('en-US');

        const result = formatFetchResult(
            createRequest({ mode: 'reader' }),
            new Response('', { status: 200, statusText: 'OK' }),
            'text/html',
            {
                content: 'Body',
                actualMode: 'reader',
                bodyTruncated: false,
                sourceTruncated: false,
                title: 'Deep dive',
                byline: 'Jane Doe',
                siteName: 'Example News',
                publishedTime: '2026-01-02',
                excerpt: 'A short summary',
            }
        );

        expect(result).toContain('Title: Deep dive');
        expect(result).toContain('Author: Jane Doe');
        expect(result).toContain('Site: Example News');
        expect(result).toContain('Published time: 2026-01-02');
        expect(result).toContain('Summary: A short summary');
    });

    it('user sees both limits reported when the page was cut twice', () => {
        setLocale('en-US');

        const result = formatFetchResult(
            createRequest({ maxChars: 3000 }),
            new Response('', { status: 200, statusText: 'OK' }),
            'text/html',
            {
                content: 'Body',
                actualMode: 'page_markdown',
                bodyTruncated: true,
                sourceTruncated: true,
            }
        );

        expect(result).toContain(
            'Source content: truncated at 1500000 characters before conversion'
        );
        expect(result).toContain('Body output: limited to 3000 characters');
    });

    it('user sees the no-content note when the page gave nothing readable', () => {
        setLocale('en-US');

        const result = formatFetchResult(
            createRequest(),
            new Response('', { status: 200, statusText: 'OK' }),
            'text/html',
            {
                content: '',
                actualMode: 'page_markdown',
                bodyTruncated: false,
                sourceTruncated: false,
            }
        );

        expect(result).toContain('[No readable page content]');
    });

    it('user sees image candidates placed above the article text', () => {
        setLocale('en-US');

        const result = formatFetchResult(
            createRequest(),
            new Response('', { status: 200, statusText: 'OK' }),
            'text/html',
            {
                content: 'Body',
                actualMode: 'page_markdown',
                bodyTruncated: false,
                sourceTruncated: false,
                imageCandidates: ['![Chart](https://example.com/chart.png)'],
            }
        );

        const candidateIndex = result.indexOf('![Chart](https://example.com/chart.png)');
        const bodyIndex = result.indexOf('Body');

        expect(candidateIndex).toBeGreaterThan(-1);
        expect(candidateIndex).toBeLessThan(bodyIndex);
        expect(result).toContain('Embeddable page image candidates');
    });

    it('user is told the response type could not be read', () => {
        setLocale('en-US');

        const request = createRequest();
        const response = new Response('', { status: 415, statusText: 'Unsupported Media Type' });

        const result = formatUnsupportedResponse(request, response, 'application/pdf');

        expect(result).toContain('Web page fetch failed');
        expect(result).toContain('Request URL: https://example.com/page');
        expect(result).toContain('Final URL: https://example.com/page');
        expect(result).toContain('HTTP status: 415 Unsupported Media Type');
        expect(result).toContain('Content type: application/pdf');
        expect(result).toContain(
            'Only HTML, JSON, Markdown, XML, and plain text responses are supported.'
        );
    });

    it('user sees the localized note when the app is in Chinese', () => {
        setLocale('zh-CN');

        const result = formatFetchResult(
            createRequest(),
            new Response('', { status: 200, statusText: 'OK' }),
            'text/html',
            {
                content: '',
                actualMode: 'page_markdown',
                bodyTruncated: false,
                sourceTruncated: false,
            }
        );

        expect(result).toContain('网页抓取');
        expect(result).toContain('页面无可读内容');
        expect(tt('网页抓取')).toBe('网页抓取');

        setLocale('en-US');
    });
});
