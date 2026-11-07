import { describe, expect, it } from 'vitest';

import { calculateSearchOverlayPosition } from '@/views/SearchView/components/SearchOverlayHost/position';

const anchor = {
    left: 100,
    top: 100,
    right: 200,
    bottom: 140,
    width: 100,
    height: 40,
};

describe('calculateSearchOverlayPosition', () => {
    it('user sees a results overlay within the visible area even when its anchor is above the screen', () => {
        const position = calculateSearchOverlayPosition({
            anchor: { left: 48, right: 798, width: 750, top: 20, bottom: 60, height: 40 },
            overlay: { width: 320, height: 384 },
            viewport: { width: 846, height: 1080 },
            minViewportTop: 300,
            maxViewportHeight: 500,
            minViewportLeft: 120,
            maxViewportRight: 846,
            overlayOnAnchor: true,
            align: 'end',
        });
        expect(position.left).toBe(128);
        expect(position.top).toBe(308);
        expect(position.maxHeight).toBe(184);
    });
    it.each([
        { minViewportLeft: 120, maxViewportRight: 846, expectedLeft: 128 },
        { minViewportLeft: 0, maxViewportRight: 260, expectedLeft: 8 },
    ])(
        'user can reach an overlay when the host extends horizontally beyond the display ($minViewportLeft)',
        ({ minViewportLeft, maxViewportRight, expectedLeft }) => {
            const position = calculateSearchOverlayPosition({
                anchor: { left: 48, top: 100, right: 798, bottom: 160, width: 750, height: 60 },
                overlay: { width: 320, height: 300 },
                viewport: { width: 846, height: 1080 },
                minViewportLeft,
                maxViewportRight,
            });
            expect(position.left).toBe(expectedLeft);
            expect(position.left + Math.min(320, position.maxWidth!)).toBeLessThanOrEqual(
                maxViewportRight - 8
            );
        }
    );
    it('uses the visible work-area top when the native host extends above the display', () => {
        const position = calculateSearchOverlayPosition({
            anchor: { left: 48, top: 450, right: 400, bottom: 492, width: 352, height: 42 },
            overlay: { width: 320, height: 300 },
            viewport: { width: 846, height: 1080 },
            minViewportTop: 300,
            maxViewportHeight: 1032,
            preferredSide: 'top',
        });
        expect(position.side).toBe('bottom');
        expect(position.top).toBe(500);
        expect(position.top).toBeGreaterThanOrEqual(308);
    });
    it('user can reach the model list above the editor when the host cannot grow further', () => {
        const position = calculateSearchOverlayPosition({
            anchor: { left: 48, top: 600, right: 400, bottom: 642, width: 352, height: 42 },
            overlay: { width: 320, height: 384 },
            viewport: { width: 846, height: 693 },
            maxViewportHeight: 645,
            allowFlip: false,
        });
        expect(position.side).toBe('top');
        expect(position.top).toBeGreaterThanOrEqual(8);
        expect(position.top + 384).toBeLessThanOrEqual(645 - 8);
    });

    it('user can scroll the whole menu when neither side has enough room', () => {
        const position = calculateSearchOverlayPosition({
            anchor: { left: 48, top: 150, right: 400, bottom: 192, width: 352, height: 42 },
            overlay: { width: 320, height: 384 },
            viewport: { width: 846, height: 300 },
            maxViewportHeight: 300,
            allowFlip: false,
        });
        expect(position.maxHeight).toBe(134);
        expect(position.top).toBe(8);
        expect(position.requiredViewportHeight).toBeNull();
    });
    it('places and aligns an overlay below its anchor by default', () => {
        expect(
            calculateSearchOverlayPosition({
                anchor,
                overlay: { width: 80, height: 60 },
                viewport: { width: 500, height: 500 },
            })
        ).toEqual({
            left: 100,
            top: 148,
            side: 'bottom',
            requiredViewportHeight: 216,
        });
    });

    it('places an overlay above its anchor when top is preferred and fits', () => {
        expect(
            calculateSearchOverlayPosition({
                anchor,
                overlay: { width: 80, height: 60 },
                viewport: { width: 500, height: 500 },
                preferredSide: 'top',
            })
        ).toEqual({
            left: 100,
            top: 32,
            side: 'top',
            requiredViewportHeight: null,
        });
    });

    it('flips below when the preferred top side cannot fit and bottom has more room', () => {
        expect(
            calculateSearchOverlayPosition({
                anchor: {
                    ...anchor,
                    top: 30,
                    bottom: 70,
                },
                overlay: { width: 120, height: 90 },
                viewport: { width: 500, height: 500 },
                preferredSide: 'top',
                align: 'end',
            })
        ).toEqual({
            left: 80,
            top: 78,
            side: 'bottom',
            requiredViewportHeight: 176,
        });
    });

    it('flips above when the preferred side cannot fit and the opposite side has more room', () => {
        expect(
            calculateSearchOverlayPosition({
                anchor: {
                    ...anchor,
                    top: 420,
                    bottom: 460,
                },
                overlay: { width: 120, height: 160 },
                viewport: { width: 500, height: 500 },
                align: 'end',
            })
        ).toEqual({
            left: 80,
            top: 252,
            side: 'top',
            requiredViewportHeight: null,
        });
    });

    it('preserves the natural anchor position while reporting the required height for a tiny viewport', () => {
        expect(
            calculateSearchOverlayPosition({
                anchor: {
                    left: 20,
                    top: 0,
                    right: 220,
                    bottom: 120,
                    width: 200,
                    height: 120,
                },
                overlay: { width: 180, height: 240 },
                viewport: { width: 300, height: 120 },
                gap: 5,
                viewportPadding: 8,
            })
        ).toEqual({
            left: 20,
            top: 125,
            side: 'bottom',
            requiredViewportHeight: 373,
        });
    });

    it('keeps a bottom overlay below an anchor when neither side fits the bounded viewport', () => {
        expect(
            calculateSearchOverlayPosition({
                anchor: {
                    ...anchor,
                    top: 64,
                    bottom: 124,
                },
                overlay: { width: 180, height: 240 },
                viewport: { width: 500, height: 160 },
                gap: 5,
                viewportPadding: 8,
            })
        ).toEqual({
            left: 100,
            top: 129,
            side: 'bottom',
            requiredViewportHeight: 377,
        });
    });

    it('clamps both axes to the padded viewport', () => {
        expect(
            calculateSearchOverlayPosition({
                anchor: {
                    left: 290,
                    top: 4,
                    right: 310,
                    bottom: 24,
                    width: 20,
                    height: 20,
                },
                overlay: { width: 140, height: 260 },
                viewport: { width: 320, height: 240 },
                align: 'center',
                viewportPadding: 12,
            })
        ).toEqual({
            left: 168,
            top: 32,
            side: 'bottom',
            requiredViewportHeight: 304,
        });
    });
});
