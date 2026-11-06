// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { describe, expect, it } from 'vitest';

import {
    resolveContentPanelHeight,
    resolveSurfacePanelStyle,
    shouldCommitPanelHeight,
} from '@/views/SearchView/searchSurfaceLayout';
import { SEARCH_WINDOW_VISUAL_OUTSET } from '@/views/SearchView/searchWindowRegions';

describe('search surface layout', () => {
    it('clamps a measured content height between the compact floor and the conversation cap', () => {
        expect(
            resolveContentPanelHeight({ contentHeight: 10, compactHeight: 60, maxHeight: 456 })
        ).toBe(60);
        expect(
            resolveContentPanelHeight({ contentHeight: 290.4, compactHeight: 60, maxHeight: 456 })
        ).toBe(291);
        expect(
            resolveContentPanelHeight({ contentHeight: 900, compactHeight: 60, maxHeight: 456 })
        ).toBe(456);
    });

    it('rounds a fractional content height up so the host never clips a half pixel', () => {
        expect(
            resolveContentPanelHeight({ contentHeight: 200.02, compactHeight: 60, maxHeight: 456 })
        ).toBe(201);
    });

    it('falls back to the compact height when the measurement is not finite', () => {
        expect(
            resolveContentPanelHeight({
                contentHeight: Number.NaN,
                compactHeight: 60,
                maxHeight: 456,
            })
        ).toBe(60);
    });

    it('user sees the panel centered without resizing the viewport', () => {
        expect(
            resolveSurfacePanelStyle({
                scaleFactor: 1.5,
                maximized: false,
                panelHeight: 300,
                viewportHeight: 800,
            })
        ).toMatchObject({
            left: `${SEARCH_WINDOW_VISUAL_OUTSET}px`,
            right: `${SEARCH_WINDOW_VISUAL_OUTSET}px`,
            top: '250px',
            bottom: 'auto',
            width: 'auto',
            height: '300px',
            transform: 'none',
        });
    });

    it('keeps a one physical pixel border at every display scale', () => {
        expect(
            resolveSurfacePanelStyle({ scaleFactor: 1, maximized: false })[
                '--search-surface-border-width'
            ]
        ).toBe('1px');
        expect(
            resolveSurfacePanelStyle({ scaleFactor: 1.5, maximized: false })[
                '--search-surface-border-width'
            ]
        ).toBe(`${2 / 1.5}px`);
    });

    it('fills the whole host when the surface is maximized', () => {
        expect(resolveSurfacePanelStyle({ scaleFactor: 2, maximized: true })).toMatchObject({
            width: '100%',
            height: '100%',
            left: '0px',
            top: '0px',
        });
    });

    it('only commits a height when it is not already the current one', () => {
        expect(shouldCommitPanelHeight({ current: null, next: 120 })).toBe(true);
        expect(shouldCommitPanelHeight({ current: 120, next: 120.2 })).toBe(false);
        expect(shouldCommitPanelHeight({ current: 120, next: 121 })).toBe(true);
        expect(shouldCommitPanelHeight({ current: 200, next: 120 })).toBe(true);
    });

    it.each([
        { centerY: 50, top: '64px' },
        { centerY: 780, top: '452px' },
    ])('user keeps the panel inside usable screen bounds at $centerY', ({ centerY, top }) => {
        expect(
            resolveSurfacePanelStyle({
                scaleFactor: 1.5,
                maximized: false,
                panelHeight: 300,
                viewportHeight: 800,
                minTop: 64,
                maxBottom: 752,
                centerY,
            }).top
        ).toBe(top);
    });
});
