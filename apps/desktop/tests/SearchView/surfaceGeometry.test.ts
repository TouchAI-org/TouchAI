// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { describe, expect, it } from 'vitest';

import {
    resolveSurfaceFrameY,
    resolveSurfaceGeometryMode,
    surfaceModeCentres,
} from '@/views/SearchView/surfaceGeometry';

const COMPACT = 60;
const SCALE = 1.5;
const IDLE_ORIGIN = 634;
const FROZEN_ORIGIN = 400;

function mode(overrides: Partial<Parameters<typeof resolveSurfaceGeometryMode>[0]> = {}) {
    return resolveSurfaceGeometryMode({
        panelHeight: COMPACT,
        compactHeight: COMPACT,
        popupOpen: false,
        maximized: false,
        manualOverride: false,
        ...overrides,
    });
}

function frameY(modeName: Parameters<typeof resolveSurfaceFrameY>[0]['mode'], panelHeight: number) {
    return resolveSurfaceFrameY({
        mode: modeName,
        panelHeight,
        compactHeight: COMPACT,
        scaleFactor: SCALE,
        idleOriginY: IDLE_ORIGIN,
        frozenOriginY: FROZEN_ORIGIN,
    });
}

describe('surface geometry mode', () => {
    it('is idle at the compact height with nothing open', () => {
        expect(mode()).toBe('idle');
    });

    it('is surface while the panel is taller than the bar', () => {
        expect(mode({ panelHeight: 304 })).toBe('surface');
    });

    it('is popup whenever a popup is open, whatever the height is', () => {
        // A popup grows the envelope while the panel stays compact: this must not read as idle.
        expect(mode({ popupOpen: true })).toBe('popup');
        expect(mode({ popupOpen: true, panelHeight: 304 })).toBe('popup');
    });

    it('lets work-area and manual placement win over everything else', () => {
        expect(mode({ maximized: true, popupOpen: true, panelHeight: 304 })).toBe('maximized');
        expect(mode({ manualOverride: true, popupOpen: true, panelHeight: 304 })).toBe('manual');
    });

    it('only centres in the mode that grows on its own', () => {
        expect(surfaceModeCentres('surface')).toBe(true);
        for (const other of ['idle', 'popup', 'manual', 'maximized'] as const) {
            expect(surfaceModeCentres(other)).toBe(false);
        }
    });
});

describe('surface frame position', () => {
    it('puts an idle surface exactly on the idle origin', () => {
        expect(frameY('idle', COMPACT)).toBe(IDLE_ORIGIN);
    });

    it('centres a surface that grows: up by half of the growth, in physical pixels', () => {
        // 244 CSS of growth at scale 1.5 moves the frame by 122 * 1.5 = 183 physical pixels.
        expect(frameY('surface', 304)).toBe(IDLE_ORIGIN - 183);
        // Asking again for the same height gives the same place: the frame cannot walk.
        expect(frameY('surface', 304)).toBe(frameY('surface', 304));
    });

    it('holds the frame at the origin a popup froze, whatever the height is', () => {
        expect(frameY('popup', COMPACT)).toBe(FROZEN_ORIGIN);
        expect(frameY('popup', 304)).toBe(FROZEN_ORIGIN);
    });

    it('leaves manual and maximized placement to the host', () => {
        expect(frameY('manual', 304)).toBeNull();
        expect(frameY('maximized', 304)).toBeNull();
    });

    it('returns null when the idle origin is unknown', () => {
        expect(
            resolveSurfaceFrameY({
                mode: 'surface',
                panelHeight: 304,
                compactHeight: COMPACT,
                scaleFactor: SCALE,
                idleOriginY: null,
                frozenOriginY: null,
            })
        ).toBeNull();
    });
});

describe('closing a popup over an open results list', () => {
    it('goes back to the idle origin instead of expanding from where the popup left it', () => {
        // The reported bug: list open, then a popup, then Esc on the window.
        expect(mode({ panelHeight: 304, popupOpen: true })).toBe('popup');
        expect(mode({ panelHeight: COMPACT, popupOpen: false })).toBe('idle');
        // The popup held the frame at 400; closing it has to move the frame back to the idle
        // origin, not leave it where the popup froze it.
        expect(frameY('popup', COMPACT)).toBe(FROZEN_ORIGIN);
        expect(frameY('idle', COMPACT)).toBe(IDLE_ORIGIN);
    });
});
