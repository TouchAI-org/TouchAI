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

describe('ClipboardService HTML normalization', () => {
    it('strips Word style artifacts while preserving visible paragraph breaks', () => {
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

    it('prefers plain visible text over HTML inline formatting Markdown', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Important text',
                html: '<p><strong>Important</strong> <em>text</em></p>',
            })
        );

        expect(payload?.text).toBe('Important text');
        expect(payload?.fragments).toEqual([{ type: 'text', text: 'Important text' }]);
    });

    it('keeps structured plain list text instead of reformatting it from HTML', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: '• First item\n• Second item',
                html: '<ul><li>First item</li><li>Second item</li></ul>',
            })
        );

        expect(payload?.text).toBe('• First item\n• Second item');
    });

    it('uses HTML list structure when paste event plain text was flattened', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'First item Second item',
                html: '<ul><li>First item</li><li>Second item</li></ul>',
            })
        );

        expect(payload?.text).toBe('- First item\n- Second item');
    });

    it('keeps table clipboard text as plain rows instead of Markdown tables', () => {
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

    it('uses HTML structure when plain text was flattened', () => {
        const payload = normalizeClipboardPayload(
            createPayload({
                text: 'Install Read docs first.',
                html: '<h2>Install</h2><p>Read <a href="https://example.com/docs">docs</a> first.</p>',
            })
        );

        expect(payload?.text).toBe('## Install\n\nRead [docs](https://example.com/docs) first.');
    });

    it('keeps plain text line breaks when HTML has no stronger structure', () => {
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

    it('splits HTML image Markdown back into ordered image fragments', () => {
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

    it('splits linked HTML images without leaving Markdown link wrapper text', () => {
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

    it('splits repeated HTML images into repeated image fragments', () => {
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

    it('preserves inline spacing around HTML image fragments', () => {
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

    it('keeps HTML image ordering even when chosen plain text differs from HTML markdown', () => {
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

    it('keeps native image fallback when HTML image sources cannot be resolved', () => {
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

    it('preserves safe image data URLs while stripping dangerous data links from HTML paste', () => {
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
