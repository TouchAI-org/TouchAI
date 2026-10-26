import { describe, expect, it } from 'vitest';

import { normalizeClipboardPayload } from '@/services/ClipboardService/html';
import type { ClipboardPayload } from '@/services/NativeService/types';

/**
 * The clipboard pipeline has to survive whatever a browser or an office suite puts on the
 * clipboard. These cover the payloads that arrive with missing fields and the link and image
 * addresses that must be dropped rather than pasted.
 */

function payloadOf(overrides: Partial<ClipboardPayload>): ClipboardPayload {
    return {
        snapshotId: 'clip-1',
        observedAt: 1,
        text: null,
        imagePaths: [],
        filePaths: [],
        fragments: [],
        ...overrides,
    };
}

describe('user pastes content whose payload is missing optional fields', () => {
    it('user gets the html converted when the payload carries no image paths at all', () => {
        const payload = normalizeClipboardPayload({
            snapshotId: 'clip-1',
            observedAt: 1,
            text: null,
            html: '<p>Just text</p>',
        } as ClipboardPayload);

        expect(payload?.text).toBe('Just text');
        expect(payload?.fragments).toEqual([{ type: 'text', text: 'Just text' }]);
    });

    it('user gets the html converted when the payload carries no fragments at all', () => {
        const payload = normalizeClipboardPayload({
            snapshotId: 'clip-1',
            observedAt: 1,
            text: null,
            html: '<p>Only html</p>',
        } as ClipboardPayload);

        expect(payload?.text).toBe('Only html');
    });

    it('user gets a saved image path used even when no native fragment was reported', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: 'See image above',
                html: '<p>See <img src="https://example.com/a.png" alt="a"> above</p>',
                htmlImages: [{ source: 'https://example.com/a.png', path: 'D:/clip/a.png' }],
                imagePaths: ['D:/clip/a.png'],
                fragments: undefined,
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'image', path: 'D:/clip/a.png' },
            { type: 'text', text: ' above' },
        ]);
    });
});

describe('user pastes a link the app refuses to keep', () => {
    it('user gets a blob link reduced to its text because the app cannot open it later', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: null,
                html: '<p><a href="blob:https://example.com/x">Blob link</a></p>',
            })
        );

        expect(payload?.text).toBe('Blob link');
        expect(payload?.text).not.toContain('blob:');
    });

    it('user gets a link with only whitespace as its address reduced to its text', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({ text: null, html: '<p><a href="   ">Empty address</a></p>' })
        );

        expect(payload?.text).toBe('Empty address');
        expect(payload?.text).not.toContain('](');
    });

    it('user gets a relative link kept when the page address could not be used', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: null,
                html: '<p><a href="/docs">docs</a></p>',
                htmlSourceUrl: '::not a url::',
            })
        );

        expect(payload?.text).toBe('[docs](/docs)');
    });

    it('user gets an image with only whitespace as its address dropped', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({ text: null, html: '<p>before<img src="   " alt="bad">after</p>' })
        );

        expect(payload?.text).toBe('beforeafter');
    });

    it('user gets a relative image kept as an absolute address the app can load', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: null,
                html: '<p><img src="/media/chart.png" alt="Chart"></p>',
                htmlSourceUrl: '::not a url::',
            })
        );

        // The browser resolves the image against the document base, so the paste keeps a
        // loadable address even when the source page address was unusable.
        expect(payload?.text).toContain('![Chart](');
        expect(payload?.text).toContain('/media/chart.png)');
    });

    it('user gets an image address with no scheme resolved against the document base', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({ text: null, html: '<p><img src="media/chart.png" alt="Chart"></p>' })
        );

        expect(payload?.text).toContain('![Chart](');
        expect(payload?.text).toContain('/media/chart.png)');
    });

    it('user gets an address with no scheme kept as a plain relative path', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({ text: null, html: '<p><a href="docs/setup">setup</a></p>' })
        );

        expect(payload?.text).toBe('[setup](docs/setup)');
    });
});

describe('user pastes markdown with escaped brackets and brackets in the address', () => {
    it('user gets an image whose label contains an escaped closing bracket recognised', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: '![a \\] label](https://cdn.example/i.png)',
                html: '<table></table>',
                imagePaths: ['D:/clip/i.png'],
            })
        );

        expect(payload?.fragments).toEqual([{ type: 'image', path: 'D:/clip/i.png' }]);
    });

    it('user gets an image whose address contains an escaped closing parenthesis recognised', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: '![logo](https://cdn.example/a\\)b.png)',
                html: '<table></table>',
                imagePaths: ['D:/clip/logo.png'],
            })
        );

        expect(payload?.fragments).toEqual([{ type: 'image', path: 'D:/clip/logo.png' }]);
    });

    it('user gets a linked image whose link is unterminated left as text', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: 'see [![logo](https://cdn.example/l.png)](https://example.com',
                html: '<table></table>',
                imagePaths: ['D:/clip/l.png'],
            })
        );

        // The broken link wrapper must not swallow the image that follows it.
        expect(payload?.fragments?.some((fragment) => fragment.type === 'image')).toBe(true);
    });

    it('user gets an image left as text when no saved file and no html image backs it', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: 'before ![logo](https://cdn.example/l.png)',
                html: '<table></table>',
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'before ![logo](https://cdn.example/l.png)' },
        ]);
    });
});

describe('user pastes text that already carries code syntax', () => {
    it('user gets the plain text kept when it already has the backticks the html would add', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: 'Run `npm test` now',
                html: '<p>Run <code>npm test</code> now</p>',
            })
        );

        // The plain text already shows the code, so re-deriving it would not improve the paste.
        expect(payload?.text).toBe('Run `npm test` now');
    });

    it('user gets the plain text kept when it already carries a fenced block', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                text: '```\nnpm test\n```',
                html: '<pre><code>npm test</code></pre>',
            })
        );

        expect(payload?.text).toBe('```\nnpm test\n```');
    });
});
