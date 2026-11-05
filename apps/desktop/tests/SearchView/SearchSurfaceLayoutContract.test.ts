import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const searchViewSource = readFileSync(
    resolve(__dirname, '../../src/views/SearchView/index.vue'),
    'utf8'
);
const tailwindCss = readFileSync(resolve(__dirname, '../../src/styles/tailwind.css'), 'utf8');

function openingDivWithMarker(source: string, marker: string): string {
    return (
        (source.match(/<(?:motion\.)?div\b[\s\S]*?>/g) ?? []).find((tag) => tag.includes(marker)) ??
        ''
    );
}

describe('Search surface layout contract', () => {
    it('keeps the viewport and clip layout-only so the card owns the visible chrome', () => {
        const frame = openingDivWithMarker(
            searchViewSource,
            'data-testid="search-view-expand-frame"'
        );
        const clip = openingDivWithMarker(
            searchViewSource,
            'data-testid="search-view-expand-clip"'
        );
        const card = openingDivWithMarker(searchViewSource, 'data-testid="search-view-card"');

        expect(frame).toContain('h-full');
        expect(frame).toContain('overflow-visible');
        expect(frame).not.toContain('search-surface-elevated');
        expect(frame).not.toContain(':style=');
        expect(clip).toContain('overflow-visible');
        expect(clip).not.toContain('overflow-hidden');
        expect(card).not.toContain(':style=');
        expect(card).toContain('search-surface-elevated');
    });

    it('keeps the card equal to the panel and animates only its growth', () => {
        const card = openingDivWithMarker(searchViewSource, 'data-testid="search-view-card"');

        expect(card).toContain('search-view-container');
        expect(card).toContain('search-view-surface-card');
        for (const token of ['w-full', 'min-h-0', 'flex-col', 'overflow-hidden']) {
            expect(card).toContain(token);
        }
        // Growth is the card's own clip reveal, which the compositor can run at full frame rate.
        expect(searchViewSource).toContain("'search-view-surface-card--revealing'");
        expect(tailwindCss).toContain('.search-view-surface-card--revealing');
        expect(tailwindCss).toContain('clip-path');
        expect(tailwindCss).toContain('height: var(--search-surface-card-height');
        expect(searchViewSource).not.toContain('search-view-surface-card--expanding');
        expect(tailwindCss).not.toContain('.search-view-surface-card--expanding');
        expect(tailwindCss).not.toContain('transition: height 380ms');
    });

    it('lets an overlay envelope float outside the card', () => {
        const card = openingDivWithMarker(searchViewSource, 'data-testid="search-view-card"');

        // The card never stretches into the host envelope a fixed overlay reserved, so the
        // overlay is drawn below the card instead of on top of the card background.
        expect(searchViewSource).toContain("'--search-surface-card-height'");
        expect(card).not.toContain(':style=');
    });

    it('keeps the page content intrinsic so the measurement can drive the host', () => {
        expect(searchViewSource).toContain("flex: '0 0 auto'");
        expect(searchViewSource).toContain('maxHeight');
        expect(searchViewSource).not.toContain("height: 'max-content'");
    });
});
