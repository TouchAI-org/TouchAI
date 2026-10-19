import { describe, expect, it } from 'vitest';

import {
    buildHeightOffsets,
    computeAboveViewportHeightDelta,
    computeMessageWindow,
    findWindowStart,
} from '@/views/SearchView/components/ConversationPanel/messageWindowing';

describe('buildHeightOffsets', () => {
    it('builds prefix sums with a leading zero and clamps negatives', () => {
        expect(buildHeightOffsets([100, 40, 60])).toEqual([0, 100, 140, 200]);
        expect(buildHeightOffsets([-10, 20])).toEqual([0, 0, 20]);
        expect(buildHeightOffsets([])).toEqual([0]);
    });
});

describe('findWindowStart', () => {
    it('finds the last item whose offset is not beyond the target', () => {
        const offsets = [0, 100, 200, 300, 400];
        expect(findWindowStart(offsets, 0)).toBe(0);
        expect(findWindowStart(offsets, 150)).toBe(1);
        expect(findWindowStart(offsets, 200)).toBe(2);
        expect(findWindowStart(offsets, 399)).toBe(3);
        expect(findWindowStart(offsets, 10_000)).toBe(4);
    });
});

describe('computeMessageWindow', () => {
    const offsets = buildHeightOffsets([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);

    it('renders only items near the viewport with spacers for the rest', () => {
        const range = computeMessageWindow({
            offsets,
            scrollTop: 400,
            viewportHeight: 200,
            overscanPx: 100,
        });

        expect(range.start).toBe(3);
        expect(range.end).toBe(7);
        expect(range.topSpacer).toBe(300);
        expect(range.bottomSpacer).toBe(300);
    });

    it('keeps the full list when it fits in the viewport', () => {
        const range = computeMessageWindow({
            offsets: buildHeightOffsets([50, 50]),
            scrollTop: 0,
            viewportHeight: 400,
        });

        expect(range).toEqual({ start: 0, end: 2, topSpacer: 0, bottomSpacer: 0 });
    });

    it('handles an empty list', () => {
        expect(computeMessageWindow({ offsets: [0], scrollTop: 0, viewportHeight: 200 })).toEqual({
            start: 0,
            end: 0,
            topSpacer: 0,
            bottomSpacer: 0,
        });
    });
});

describe('computeAboveViewportHeightDelta', () => {
    it('only counts changes that happened above the viewport', () => {
        expect(
            computeAboveViewportHeightDelta(
                [
                    { top: 0, delta: 20 },
                    { top: 100, delta: -5 },
                    { top: 500, delta: 40 },
                ],
                200
            )
        ).toBe(15);
    });
});
