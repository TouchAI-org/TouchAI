import { describe, expect, it } from 'vitest';

import {
    resizeSearchHostFrame,
    resizeSearchPanelFrame,
    type SearchPanelFrame,
    type SearchPanelResizeDirection,
} from '@/views/SearchView/panelResizeGeometry';

const START_FRAME: SearchPanelFrame = {
    left: 200,
    top: 200,
    width: 600,
    height: 300,
};

function resize(
    direction: SearchPanelResizeDirection,
    deltaX: number,
    deltaY: number,
    overrides: Partial<Parameters<typeof resizeSearchPanelFrame>[0]> = {}
) {
    return resizeSearchPanelFrame({
        startFrame: START_FRAME,
        direction,
        deltaX,
        deltaY,
        viewportWidth: 1200,
        viewportHeight: 800,
        scaleFactor: 1,
        minWidth: 420,
        minHeight: 60,
        visualInset: 48,
        allowHeightOverride: true,
        ...overrides,
    });
}

describe('resizeSearchPanelFrame', () => {
    it.each<[SearchPanelResizeDirection, SearchPanelFrame]>([
        ['n', { left: 200, top: 240, width: 600, height: 260 }],
        ['ne', { left: 200, top: 240, width: 650, height: 260 }],
        ['e', { left: 200, top: 200, width: 650, height: 300 }],
        ['se', { left: 200, top: 200, width: 650, height: 340 }],
        ['s', { left: 200, top: 200, width: 600, height: 340 }],
        ['sw', { left: 250, top: 200, width: 550, height: 340 }],
        ['w', { left: 250, top: 200, width: 550, height: 300 }],
        ['nw', { left: 250, top: 240, width: 550, height: 260 }],
    ])('resizes %s while keeping every opposite edge fixed', (direction, expected) => {
        expect(resize(direction, 50, 40)).toEqual(expected);
    });

    it('enforces minimum width and height without moving the opposite edges', () => {
        expect(resize('nw', 1000, 1000)).toEqual({
            left: 380,
            top: 440,
            width: 420,
            height: 60,
        });
    });

    it('keeps the complete 48px visual outset inside the host viewport', () => {
        const startFrame = { left: 200, top: 200, width: 600, height: 300 };

        expect(resize('nw', -1000, -1000, { startFrame })).toEqual({
            left: 48,
            top: 48,
            width: 752,
            height: 452,
        });
        expect(resize('se', 1000, 1000, { startFrame })).toEqual({
            left: 200,
            top: 200,
            width: 952,
            height: 552,
        });
    });

    it('keeps vertical geometry unchanged when height override is disabled', () => {
        expect(resize('se', 50, 120, { allowHeightOverride: false })).toEqual({
            left: 200,
            top: 200,
            width: 650,
            height: 300,
        });
        expect(resize('n', 0, -120, { allowHeightOverride: false })).toEqual(START_FRAME);
    });

    it.each([1, 1.25, 1.5, 2])(
        'snaps all four frame edges to physical pixels at %sx display scale',
        (scaleFactor) => {
            const frame = resize('nw', 17.17, 23.23, {
                scaleFactor,
                startFrame: { left: 200.2, top: 199.8, width: 600.4, height: 300.3 },
            });
            const edges = [
                frame.left,
                frame.top,
                frame.left + frame.width,
                frame.top + frame.height,
            ];

            for (const edge of edges) {
                expect(edge * scaleFactor).toBeCloseTo(Math.round(edge * scaleFactor), 8);
            }
        }
    );
});

describe('user resizes a bounded search host', () => {
    it.each([1, 1.25, 1.5, 2])('grows beyond the current viewport at %sx scale', (scaleFactor) => {
        const start = { width: 750, height: 290, physicalOrigin: { x: 200, y: 180 } };
        const resized = resizeSearchHostFrame({
            start,
            direction: 'se',
            deltaX: 100,
            deltaY: 100,
            workArea: { position: { x: 0, y: 40 }, size: { width: 2560, height: 1400 } },
            scaleFactor,
            minWidth: 750,
            minHeight: 60,
            allowHeightOverride: true,
        });

        expect(resized.width).toBe(Math.ceil(750 * scaleFactor) / scaleFactor + 100);
        expect(resized.height).toBe(Math.ceil(290 * scaleFactor) / scaleFactor + 100);
        expect(resized.physicalOrigin).toEqual(start.physicalOrigin);
    });

    it('keeps the opposite corner fixed at the work area edge on a negative monitor', () => {
        const resized = resizeSearchHostFrame({
            start: { width: 750, height: 290, physicalOrigin: { x: -1500, y: 180 } },
            direction: 'nw',
            deltaX: -1000,
            deltaY: -1000,
            workArea: { position: { x: -1920, y: 40 }, size: { width: 1920, height: 1040 } },
            scaleFactor: 1.5,
            minWidth: 750,
            minHeight: 60,
            allowHeightOverride: true,
        });

        expect(resized.physicalOrigin).toEqual({ x: -1920, y: -56 });
        expect(resized.physicalOrigin.x + resized.width * 1.5).toBe(-1500 + 750 * 1.5);
        expect(resized.physicalOrigin.y + resized.height * 1.5).toBe(180 + 290 * 1.5);
    });
});
