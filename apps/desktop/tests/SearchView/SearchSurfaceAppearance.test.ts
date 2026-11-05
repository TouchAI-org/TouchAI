import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const searchViewSource = readFileSync(
    resolve(__dirname, '../../src/views/SearchView/index.vue'),
    'utf8'
);
const modelDropdownSource = readFileSync(
    resolve(__dirname, '../../src/views/SearchView/components/ModelDropdownPopup/index.vue'),
    'utf8'
);
const sessionHistorySource = readFileSync(
    resolve(__dirname, '../../src/views/SearchView/components/SessionHistoryPopover/index.vue'),
    'utf8'
);
const tailwindCss = readFileSync(resolve(__dirname, '../../src/styles/tailwind.css'), 'utf8');

function elevatedSurfaceRuleBody(): string {
    const match = tailwindCss.match(/\.search-surface-elevated\s*\{\s*([^}]+)\}/);
    return match?.[1] ?? '';
}

function openingDivWithMarker(source: string, marker: string): string {
    return (
        (source.match(/<(?:motion\.)?div\b[\s\S]*?>/g) ?? []).find((tag) => tag.includes(marker)) ??
        ''
    );
}

describe('Search surface appearance', () => {
    it('keeps the viewport layout-only and puts the visible chrome on the card', () => {
        const mainPanelRoot = openingDivWithMarker(searchViewSource, 'data-testid="search-view"');
        const mainPanelCard = openingDivWithMarker(
            searchViewSource,
            'data-testid="search-view-card"'
        );
        const expandFrame = openingDivWithMarker(
            searchViewSource,
            'data-testid="search-view-expand-frame"'
        );
        const expandClip = openingDivWithMarker(
            searchViewSource,
            'data-testid="search-view-expand-clip"'
        );

        expect(mainPanelRoot).not.toContain('search-surface-elevated');
        expect(expandFrame).toContain('search-view-surface-viewport');
        expect(expandFrame).toContain('h-full');
        expect(expandFrame).toContain('overflow-visible');
        expect(expandFrame).not.toContain('search-surface-elevated');
        expect(expandClip).toContain('search-view-surface-clip');
        expect(expandClip).toContain('overflow-visible');
        expect(expandClip).not.toContain('overflow-hidden');
        expect(mainPanelCard).toContain('search-view-surface-card');
        expect(mainPanelCard).toContain("!settledWindowMaximized ? 'search-surface-elevated' : ''");
        for (const token of ['h-full', 'w-full', 'min-h-0', 'flex-col', 'overflow-hidden']) {
            expect(mainPanelCard).toContain(token);
        }
        expect(mainPanelCard).not.toContain('search-view-surface-card--expanding');
        expect(tailwindCss).not.toContain('.search-view-surface-card--expanding');
        expect(tailwindCss).not.toContain('contain: paint');
    });

    it('uses one elevated surface contract for the panel card and direct overlays', () => {
        const body = elevatedSurfaceRuleBody();
        expect(body).toContain(
            'border: var(--search-surface-border-width, 1px) solid var(--search-surface-border);'
        );
        expect(body).toContain('background-color: var(--search-surface-background);');
        expect(body).toContain('border-radius: var(--search-surface-radius);');
        expect(body).toContain('box-shadow: var(--search-surface-shadow);');
        expect(searchViewSource).toContain(
            "!settledWindowMaximized ? 'search-surface-elevated' : ''"
        );
        expect(searchViewSource).not.toContain('search-view-container--monitor-host');
    });

    it('uses one elevated surface contract for the search panel and direct overlays', () => {
        expect(tailwindCss).toContain('--search-surface-background: rgb(251 251 246);');
        expect(tailwindCss).toContain('--search-surface-border: rgb(209 213 219);');
        expect(tailwindCss).toContain('--search-surface-radius: 0.5rem;');
        expect(tailwindCss).toContain('0 8px 18px -3px rgb(0 0 0 / 0.36)');
        expect(tailwindCss).toContain('0 2px 6px -1px rgb(0 0 0 / 0.18)');

        const overlaySources: ReadonlyArray<readonly [string, string]> = [
            [modelDropdownSource, 'data-model-dropdown-popover="true"'],
            [sessionHistorySource, 'data-search-history-popover="true"'],
        ];
        for (const [source, marker] of overlaySources) {
            const rootTag = openingDivWithMarker(source, marker);
            expect(rootTag).toContain('search-surface-elevated');
            expect(rootTag).not.toMatch(/\bborder-stone-200\/90\b/);
            expect(rootTag).not.toMatch(/\bbg-white\b/);
            expect(rootTag).not.toMatch(/\bshadow-lg\b/);
            expect(rootTag).not.toMatch(/\bbackdrop-blur\b/);
        }

        expect(searchViewSource).not.toContain('bg-background-primary');
        expect(searchViewSource).toContain(':style="searchSurfaceStyle"');
        expect(searchViewSource).toContain("'--search-surface-border-width'");
    });

    it('caps idle page content at the default auto session height', () => {
        expect(searchViewSource).toContain('const pageContentStyle = computed');
        expect(searchViewSource).toContain('resolveAutoSessionPanelHeight');
        expect(searchViewSource).toContain(':style="pageContentStyle"');
        expect(searchViewSource).toContain('maxHeight: `${pageContentMaxHeight.value}px`');
    });

    it('lets the page content column fill the maximized host so the search bar stays at the bottom', () => {
        expect(searchViewSource).toMatch(
            /ref="pageContent"[\s\S]*fillConversationAvailableHeight\s*\|\|\s*effectiveWindowMaximized/
        );
        expect(searchViewSource).toMatch(/\bh-full min-h-0 flex-1\b/);
    });
});
