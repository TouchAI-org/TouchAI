import { describe, expect, it } from 'vitest';

import {
    resolveDesiredOffset,
    resolveEffectiveAlign,
    resolveNavigationCorrection,
} from '@/views/SearchView/components/ConversationPanel/navigationAnchor';

describe('when the user jumps to a message', () => {
    it('user gets the top gap honoured for start alignment', () => {
        expect(resolveDesiredOffset('start', 12, 300, 600)).toBe(12);
        expect(resolveDesiredOffset('start', 0, 300, 600)).toBe(0);
    });

    it('user gets the message centred for a short message', () => {
        expect(resolveDesiredOffset('center', 0, 100, 600)).toBe(250);
    });

    it('user gets the message bottom-aligned for end alignment', () => {
        expect(resolveDesiredOffset('end', 0, 100, 600)).toBe(500);
        expect(resolveDesiredOffset('end', 12, 100, 600)).toBe(488);
    });

    it('user gets the start of a long answer instead of its middle', () => {
        expect(resolveEffectiveAlign('center', 4000, 600)).toBe('start');
        expect(resolveDesiredOffset('center', 0, 4000, 600)).toBe(0);
    });
});

describe('when the list re-measures after the jump', () => {
    it('user is corrected by exactly the observed offset error', () => {
        // 期望元素顶部落在 12px，实际落在 320px → 往回补 308。
        expect(resolveNavigationCorrection(320, 12)).toBe(308);
    });

    it('user is left alone once the element sits where it was placed', () => {
        expect(resolveNavigationCorrection(12, 12)).toBe(0);
        expect(resolveNavigationCorrection(12.5, 12)).toBe(0);
    });

    it('user is corrected in the other direction too', () => {
        expect(resolveNavigationCorrection(-40, 12)).toBe(-52);
    });

    it('user keeps the correction converging: applying it zeroes the error', () => {
        const desired = 12;
        const current = 320;
        const correction = resolveNavigationCorrection(current, desired);

        expect(current - correction).toBe(desired);
        expect(resolveNavigationCorrection(current - correction, desired)).toBe(0);
    });
});
