import { describe, expect, it } from 'vitest';

import {
    contentWindowFrame,
    SEARCH_WINDOW_IDLE_HEIGHT,
    SEARCH_WINDOW_RESULTS_HEIGHT,
    SEARCH_WINDOW_WIDTH,
    searchWindowFrame,
    SETTINGS_WINDOW_CONTENT_HEIGHT,
    SETTINGS_WINDOW_CONTENT_WIDTH,
    SETTINGS_WINDOW_HEIGHT,
    SETTINGS_WINDOW_WIDTH,
    WINDOW_SHADOW_GUTTER,
} from '../../../.github/ui-preview/lib/profile.mjs';

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

describe('user reviews the settings window without its shadow gutter', () => {
    it('user sees the designed 1120x700 surface inside the 1168x748 native window', () => {
        expect(WINDOW_SHADOW_GUTTER).toBe(24);
        expect(SETTINGS_WINDOW_CONTENT_WIDTH).toBe(1120);
        expect(SETTINGS_WINDOW_CONTENT_HEIGHT).toBe(700);
        expect(SETTINGS_WINDOW_WIDTH).toBe(1168);
        expect(SETTINGS_WINDOW_HEIGHT).toBe(748);
        expect(
            contentWindowFrame({
                width: SETTINGS_WINDOW_WIDTH,
                height: SETTINGS_WINDOW_HEIGHT,
                x: 0,
                y: 0,
            })
        ).toEqual({ width: 1120, height: 700, x: 24, y: 24 });
    });
});
