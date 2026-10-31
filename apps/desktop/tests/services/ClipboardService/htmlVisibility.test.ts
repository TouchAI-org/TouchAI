import { describe, expect, it } from 'vitest';

import { normalizeClipboardPayload } from '@/services/ClipboardService/html';
import type { ClipboardPayload } from '@/services/NativeService/types';

function payloadOf(overrides: Partial<ClipboardPayload>): ClipboardPayload {
    return {
        snapshotId: 'clip-visibility',
        observedAt: 1,
        text: null,
        imagePaths: [],
        filePaths: [],
        fragments: [],
        ...overrides,
    };
}

describe('user pastes HTML with inline visibility styles', () => {
    it.each(['opacity: 0.5', 'opacity: .5', 'opacity: 0.05', 'opacity: 50%'])(
        'user keeps visible text when its inline style is %s',
        (style) => {
            const payload = normalizeClipboardPayload(
                payloadOf({ html: `<p style="${style}">Visible text</p>` })
            );

            expect(payload?.text).toBe('Visible text');
            expect(payload?.fragments).toEqual([{ type: 'text', text: 'Visible text' }]);
        }
    );

    it('user keeps a partially transparent image between its surrounding text when pasting', () => {
        const payload = normalizeClipboardPayload(
            payloadOf({
                html: '<p>Before<img style="opacity: 0.5" src="https://example.com/chart.png" alt="Chart">After</p>',
                htmlImages: [
                    { source: 'https://example.com/chart.png', path: 'D:/clip/chart.png' },
                ],
                imagePaths: ['D:/clip/chart.png'],
            })
        );

        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'Before' },
            { type: 'image', path: 'D:/clip/chart.png' },
            { type: 'text', text: 'After' },
        ]);
    });

    it.each([
        'opacity: 0; opacity: 1',
        'display: none; display: block',
        'visibility: hidden; visibility: visible',
        '--opacity: 0',
        '--display: none',
        '--visibility: hidden',
    ])('user keeps visible text when CSS declarations resolve to a visible style: %s', (style) => {
        const payload = normalizeClipboardPayload(
            payloadOf({ html: `<p style="${style}">Visible text</p>` })
        );

        expect(payload?.text).toBe('Visible text');
    });

    it.each(['opacity: 0', 'opacity: 0%', 'opacity: -0.5', 'display: none', 'visibility: hidden'])(
        'user excludes hidden text when its inline style is %s',
        (style) => {
            const payload = normalizeClipboardPayload(
                payloadOf({
                    html: `<p>Before</p><div style="${style}"><span>Hidden text</span></div><p>After</p>`,
                })
            );

            expect(payload?.text).toBe('Before\n\nAfter');
            expect(payload?.fragments).toEqual([{ type: 'text', text: 'Before\n\nAfter' }]);
        }
    );
});
