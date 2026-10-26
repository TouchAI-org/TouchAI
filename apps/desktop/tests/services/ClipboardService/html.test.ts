import { describe, expect, it } from 'vitest';

import { normalizeClipboardPayload } from '@/services/ClipboardService/html';
import type { ClipboardPayload } from '@/services/NativeService/types';

function createPayload(overrides: Partial<ClipboardPayload>): ClipboardPayload {
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

describe('user pastes rich content from a web page or document', () => {
    it('user gets clean paragraph breaks without Word style artifacts', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Visible Word text\nSecond line',
                html: `
                    <html>
                        <head>
                            <style>p.MsoNormal { margin: 0cm; }</style>
                            <script>window.__officePaste = true;</script>
                        </head>
                        <body>
                            <p class="MsoNormal">Visible Word text</p>
                            <style>.late-rule { color: red; }</style>
                            <p>Second line</p>
                        </body>
                    </html>
                `,
            })
        );

        expect(payload?.text).toBe('Visible Word text\nSecond line');
        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'Visible Word text\nSecond line' },
        ]);
        expect(payload?.text).not.toContain('MsoNormal');
        expect(payload?.text).not.toContain('margin');
    });

    it('user gets the visible text instead of inline formatting markup', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Important text',
                html: '<p><strong>Important</strong> <em>text</em></p>',
            })
        );

        expect(payload?.text).toBe('Important text');
        expect(payload?.fragments).toEqual([{ type: 'text', text: 'Important text' }]);
    });

    it('user gets a pasted list as structured plain text', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '• First item\n• Second item',
                html: '<ul><li>First item</li><li>Second item</li></ul>',
            })
        );

        expect(payload?.text).toBe('• First item\n• Second item');
    });

    it('user gets a list kept when the browser flattened the plain text', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'First item Second item',
                html: '<ul><li>First item</li><li>Second item</li></ul>',
            })
        );

        expect(payload?.text).toBe('- First item\n- Second item');
    });

    it('user gets pasted table text as plain rows instead of a markdown table', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Name\tAge\nAlice\t28',
                html: `
                    <table>
                        <tr><th>Name</th><th>Age</th></tr>
                        <tr><td>Alice</td><td>28</td></tr>
                    </table>
                `,
            })
        );

        expect(payload?.text).toBe('Name\tAge\nAlice\t28');
        expect(payload?.fragments).toEqual([{ type: 'text', text: 'Name\tAge\nAlice\t28' }]);
        expect(payload?.text).not.toContain('| --- |');
    });

    it('user gets structure from the HTML when the plain text was flattened', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Install Read docs first.',
                html: '<h2>Install</h2><p>Read <a href="https://example.com/docs">docs</a> first.</p>',
            })
        );

        expect(payload?.text).toBe('## Install\n\nRead [docs](https://example.com/docs) first.');
    });

    it('user gets plain-text line breaks when the HTML has no stronger structure', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '毕业设计开题报告\n题目： 基于大语言模型的桌面效率 Agent 系统设计与实现\n姓 名： 谢志勇',
                html: '<span>毕业设计开题报告 题目： 基于大语言模型的桌面效率 Agent 系统设计与实现 姓 名： 谢志勇</span>',
            })
        );

        expect(payload?.text).toBe(
            '毕业设计开题报告\n题目： 基于大语言模型的桌面效率 Agent 系统设计与实现\n姓 名： 谢志勇'
        );
    });

    it('user gets pasted images as ordered image fragments', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Before\nAfter',
                html: '<p>Before</p><img src="https://example.com/full.png" alt="Preview"><p>After</p>',
                htmlImages: [{ source: 'https://example.com/full.png', path: 'D:/clip/full.png' }],
                fragments: [{ type: 'image', path: 'D:/clip/full.png' }],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'Before' },
            { type: 'image', path: 'D:/clip/full.png' },
            { type: 'text', text: 'After' },
        ]);
    });

    it('user gets linked images without leftover link wrapper text', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Before\nAfter',
                html: '<p>Before</p><a href="https://example.com/full.png"><img src="https://example.com/thumb.png" alt="Preview"></a><p>After</p>',
                htmlImages: [{ source: 'https://example.com/full.png', path: 'D:/clip/full.png' }],
                fragments: [{ type: 'image', path: 'D:/clip/full.png' }],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'Before' },
            { type: 'image', path: 'D:/clip/full.png' },
            { type: 'text', text: 'After' },
        ]);
    });

    it('user gets repeated images as repeated fragments', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Before\nBetween\nAfter',
                html: '<p>Before</p><img src="https://example.com/reused.png" alt="Preview"><p>Between</p><img src="https://example.com/reused.png" alt="Preview"><p>After</p>',
                htmlImages: [
                    { source: 'https://example.com/reused.png', path: 'D:/clip/reused.png' },
                    { source: 'https://example.com/reused.png', path: 'D:/clip/reused.png' },
                ],
                fragments: [{ type: 'image', path: 'D:/clip/reused.png' }],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'Before' },
            { type: 'image', path: 'D:/clip/reused.png' },
            { type: 'text', text: 'Between' },
            { type: 'image', path: 'D:/clip/reused.png' },
            { type: 'text', text: 'After' },
        ]);
    });

    it('user gets inline spacing preserved around pasted images', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'See image above',
                html: '<p>See <img src="https://example.com/inline.png" alt="inline"> above</p>',
                htmlImages: [
                    { source: 'https://example.com/inline.png', path: 'D:/clip/inline.png' },
                ],
                fragments: [{ type: 'image', path: 'D:/clip/inline.png' }],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'image', path: 'D:/clip/inline.png' },
            { type: 'text', text: ' above' },
        ]);
    });

    it('user gets pasted images in their original order', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'See image above',
                html: '<p>See <img src="https://example.com/inline.png" alt="inline"> above</p>',
                htmlImages: [
                    { source: 'https://example.com/inline.png', path: 'D:/clip/inline.png' },
                ],
                imagePaths: ['D:/clip/inline.png'],
                fragments: [{ type: 'image', path: 'D:/clip/inline.png' }],
            })
        );

        expect(payload?.text).toBe('See image above');
        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'image', path: 'D:/clip/inline.png' },
            { type: 'text', text: ' above' },
        ]);
    });

    it('user gets an image fallback when pasted image sources cannot be resolved', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'See image above',
                html: '<p>See <img src="blob:https://example.com/unresolved" alt="inline"> above</p>',
                htmlImages: [{ source: 'blob:https://example.com/unresolved', path: null }],
                imagePaths: ['D:/clip/native-inline.png'],
                fragments: [{ type: 'image', path: 'D:/clip/native-inline.png' }],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'image', path: 'D:/clip/native-inline.png' },
            { type: 'text', text: ' above' },
        ]);
    });

    it('user gets safe image data kept while dangerous data links are stripped', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: `
                    <p>
                        Keep <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">bad</a>
                        <img src="data:image/png;base64,AAAA" alt="preview">
                        <img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" alt="drop">
                    </p>
                `,
            })
        );

        expect(payload?.text).toContain('Keep bad');
        expect(payload?.text).toContain('![preview](data:image/png;base64,AAAA)');
        expect(payload?.text).not.toContain('data:text/html');
    });
});

describe('user pastes text formatting that plain text cannot carry', () => {
    it('user gets strikethrough and highlight markers when the page had them', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<p><del>old price</del> and <mark>new price</mark></p>',
            })
        );

        expect(payload?.text).toBe('~~old price~~ and ==new price==');
    });

    it('user gets empty strikethrough and highlight spans dropped instead of leaving empty markers', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<p>a<del>   </del>b<mark></mark>c</p>',
            })
        );

        expect(payload?.text).not.toContain('~~');
        expect(payload?.text).not.toContain('==');
        expect(payload?.text?.replace(/\s+/g, '')).toBe('abc');
    });

    it('user gets inline code kept when the browser flattened it away', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Run npm test now',
                html: '<p>Run <code>npm test</code> now</p>',
            })
        );

        expect(payload?.text).toBe('Run `npm test` now');
    });

    it('user gets a quoted passage marked as a quote when the plain text lost the block', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Ask not what your country can do for you Ask what you can do',
                html: '<blockquote><p>Ask not what your country can do for you</p></blockquote><h2>Ask what you can do</h2>',
            })
        );

        expect(payload?.text).toBe(
            '> Ask not what your country can do for you\n\n## Ask what you can do'
        );
    });

    it('user gets list spacing inside a pasted code block left exactly as written', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<pre><code>-  keep  this</code></pre>',
            })
        );

        // Collapsing the spacing inside a fence would change the code the user pasted.
        expect(payload?.text).toContain('```');
        expect(payload?.text).toContain('-  keep  this');
    });

    it('user gets a pasted markdown table kept as markdown instead of flattened into tabs', () => {
        const markdownTable = '| Name | Age |\n| --- | --- |\n| Alice | 28 |';
        const payload = normalizeClipboardPayload(
            createPayload({
                text: markdownTable,
                html: '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>28</td></tr></table>',
            })
        );

        expect(payload?.text).toBe(markdownTable);
    });

    it('user gets table cells as tab-separated rows when the plain text had no table shape', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Name Age Alice 28',
                html: '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>28</td></tr></table>',
            })
        );

        expect(payload?.text).toBe('Name\tAge\nAlice\t28');
    });

    it('user gets a short table row ending at its last filled cell', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<table><tr><th>Name</th><th>Age</th><th>City</th></tr><tr><td>Alice</td><td>28</td></tr></table>',
            })
        );

        // No padding is added past the last cell of a short row, so the paste has no stray tabs.
        expect(payload?.text).toBe('Name\tAge\tCity\nAlice\t28');
    });

    it('user gets a table with no rows contributing no text', () => {
        const payload = normalizeClipboardPayload(
            createPayload({ text: null, html: '<table></table>' })
        );

        expect(payload?.text).toBeNull();
    });
});

describe('user pastes links and images from a web page', () => {
    it('user gets relative links resolved against the page the copy came from', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<p>Read <a href="../guide/setup">the guide</a></p>',
                htmlSourceUrl: 'https://example.com/docs/start/',
            })
        );

        expect(payload?.text).toBe('Read [the guide](https://example.com/docs/guide/setup)');
    });

    it('user gets a mailto link kept while a script link is reduced to its text', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: [
                    '<p><a href="mailto:team@example.com">Mail the team</a></p>',
                    '<p><a href="javascript:alert(1)">Click me</a></p>',
                ].join(''),
            })
        );

        expect(payload?.text).toContain('[Mail the team](mailto:team@example.com)');
        expect(payload?.text).toContain('Click me');
        expect(payload?.text).not.toContain('javascript:');
    });

    it('user gets an in-page anchor link kept so it still jumps within the paste', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<p><a href="#appendix">Appendix</a></p>',
            })
        );

        expect(payload?.text).toBe('[Appendix](#appendix)');
    });

    it('user gets relative links left as written when the source page address is unusable', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<p><a href="../guide/setup">the guide</a></p>',
                htmlSourceUrl: 'not a real address',
            })
        );

        expect(payload?.text).toBe('[the guide](../guide/setup)');
    });

    it('user gets blob and cid image sources kept for pasted mail content', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: [
                    '<p><img src="blob:https://example.com/9d1b" alt="shot"></p>',
                    '<p><img src="cid:inline-image-1" alt="inline"></p>',
                ].join(''),
            })
        );

        expect(payload?.text).toContain('![shot](blob:https://example.com/9d1b)');
        expect(payload?.text).toContain('![inline](cid:inline-image-1)');
    });

    it('user gets a script image source dropped instead of leaking into the paste', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<p>before<img src="javascript:alert(1)" alt="bad">after</p>',
            })
        );

        expect(payload?.text).toBe('beforeafter');
        expect(payload?.text).not.toContain('javascript:');
    });
});

describe('user pastes content with hidden and decorative parts', () => {
    it('user gets hidden blocks dropped instead of pasted as text', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: [
                    '<p>visible</p>',
                    '<div style="display: none">display secret</div>',
                    '<div style="visibility:hidden">visibility secret</div>',
                    '<div style="opacity:0">opacity secret</div>',
                    '<div hidden>hidden attribute secret</div>',
                    '<div aria-hidden="true">aria secret</div>',
                ].join(''),
            })
        );

        expect(payload?.text).toBe('visible');
    });

    it('user gets a hidden block dropped even when the style uses unusual spacing and case', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: null,
                html: '<p>kept</p><div style="DISPLAY :  None">dropped</div>',
            })
        );

        expect(payload?.text).toBe('kept');
    });

    it('user gets the paste left untouched when it carries no html at all', () => {
        const payload = createPayload({ text: '  plain text  ', html: '   ' });

        expect(normalizeClipboardPayload(payload)).toBe(payload);
        expect(normalizeClipboardPayload(null)).toBeNull();
    });
});

describe('user pastes files and images without any text', () => {
    it('user gets the pasted files and images when there is no text at all', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '   ',
                html: '<p></p>',
                imagePaths: ['D:/clip/shot.png'],
                fragments: [
                    { type: 'image', path: 'D:/clip/shot.png' },
                    { type: 'file', path: 'D:/clip/report.pdf' },
                ],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'image', path: 'D:/clip/shot.png' },
            { type: 'file', path: 'D:/clip/report.pdf' },
        ]);
    });

    it('user gets the same image listed once even when it arrives twice', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '   ',
                html: '<p></p>',
                imagePaths: ['D:/clip/shot.png'],
                fragments: [{ type: 'image', path: 'D:/clip/shot.png' }],
            })
        );

        expect(payload?.fragments).toEqual([{ type: 'image', path: 'D:/clip/shot.png' }]);
    });
});

describe('user pastes markdown source text', () => {
    it('user gets an image written as markdown source turned into an image fragment', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '![logo](https://cdn.example/logo.png)',
                html: '<table></table>',
                imagePaths: ['D:/clip/logo.png'],
            })
        );

        expect(payload?.fragments).toEqual([{ type: 'image', path: 'D:/clip/logo.png' }]);
    });

    it('user gets a linked image written as markdown source turned into one image fragment', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '[![logo](https://cdn.example/logo.png)](https://example.com)',
                html: '<table></table>',
                imagePaths: ['D:/clip/logo.png'],
            })
        );

        expect(payload?.fragments).toEqual([{ type: 'image', path: 'D:/clip/logo.png' }]);
    });

    it('user gets an image whose label contains an escaped bracket still recognised', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '![a \\] label](https://cdn.example/i.png)',
                html: '<table></table>',
                imagePaths: ['D:/clip/i.png'],
            })
        );

        expect(payload?.fragments).toEqual([{ type: 'image', path: 'D:/clip/i.png' }]);
    });

    it('user gets an image with a bracketed destination still recognised', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '![logo](<https://cdn.example/logo.png>)',
                html: '<table></table>',
                imagePaths: ['D:/clip/logo.png'],
            })
        );

        expect(payload?.fragments).toEqual([{ type: 'image', path: 'D:/clip/logo.png' }]);
    });

    it('user gets an unfinished image syntax left as text instead of losing it', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'before ![logo](https://cdn.example/logo.png',
                html: '<table></table>',
                imagePaths: ['D:/clip/logo.png'],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'before ![logo](https://cdn.example/logo.png' },
            { type: 'image', path: 'D:/clip/logo.png' },
        ]);
    });

    it('user gets a bracket that is not an image kept as text', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'before ![ not an image after',
                html: '<table></table>',
                imagePaths: ['D:/clip/other.png'],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'before ![ not an image after' },
            { type: 'image', path: 'D:/clip/other.png' },
        ]);
    });

    it('user gets an image left as markdown when no saved file backs it', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'before ![first](https://cdn.example/1.png) after ![second](https://cdn.example/2.png)',
                html: '<table></table>',
                htmlImages: [{ source: 'https://cdn.example/1.png', path: 'D:/clip/1.png' }],
            })
        );

        // The unresolvable image stays in the text so the user still sees which image was there.
        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'before ' },
            { type: 'image', path: 'D:/clip/1.png' },
            { type: 'text', text: ' after ![second](https://cdn.example/2.png)' },
        ]);
    });
});

describe('user pastes text where boundary whitespace matters', () => {
    it('user gets the trailing newline kept when the caller asked to preserve it', () => {
        const payload = normalizeClipboardPayload(
            createPayload({ text: 'line\n', html: '<span>line</span>' }),
            { preservePlainText: true }
        );

        expect(payload?.text).toBe('line\n');
    });

    it('user gets the trailing newline trimmed when the caller did not ask to preserve it', () => {
        const payload = normalizeClipboardPayload(
            createPayload({ text: 'line\n', html: '<span>line</span>' })
        );

        expect(payload?.text).toBe('line');
    });
});
