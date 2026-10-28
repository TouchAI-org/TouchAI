import { describe, expect, it } from 'vitest';

import {
    SEARCH_WINDOW_IDLE_HEIGHT,
    SEARCH_WINDOW_RESULTS_HEIGHT,
    SEARCH_WINDOW_WIDTH,
    searchWindowFrame,
} from '../../../.github/ui-preview/lib/window-frame.mjs';

const stage = { width: 1920, height: 1080 };

describe('user reviews an empty search window', () => {
    it('user sees the compact bar instead of an empty results frame', () => {
        const frame = searchWindowFrame(stage);

        expect(frame).toEqual({
            width: SEARCH_WINDOW_WIDTH,
            height: SEARCH_WINDOW_IDLE_HEIGHT,
            x: 585,
            y: 510,
        });
    });
});

describe('user reviews search results', () => {
    it('user sees one expanded frame that keeps the same center', () => {
        const compact = searchWindowFrame(stage);
        const expanded = searchWindowFrame(stage, { expanded: true });

        expect(expanded.width).toBe(SEARCH_WINDOW_WIDTH);
        expect(expanded.height).toBe(SEARCH_WINDOW_RESULTS_HEIGHT);
        expect(expanded.x).toBe(compact.x);
        expect(expanded.y + expanded.height / 2).toBe(compact.y + compact.height / 2);
    });

    it('user sees the results frame fit its content instead of leaving a blank area', () => {
        const frame = searchWindowFrame(stage, { expanded: true, contentHeight: 207 });

        expect(frame.height).toBe(207);
        expect(frame.y).toBe(437);
    });

    it('user never gets a results frame taller than the stable maximum', () => {
        const frame = searchWindowFrame(stage, { expanded: true, contentHeight: 900 });

        expect(frame.height).toBe(SEARCH_WINDOW_RESULTS_HEIGHT);
    });
});
