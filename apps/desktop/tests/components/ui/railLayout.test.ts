import { describe, expect, it } from 'vitest';

import { resolveRailLayout } from '@/components/ui/message-scroller/railLayout';

describe('when the window is short or the conversation is long', () => {
    it('user gets comfortable dots when they fit in the window', () => {
        const layout = resolveRailLayout({ itemCount: 10, availableHeight: 400 });

        expect(layout.itemSize).toBe(14);
        expect(layout.totalHeight).toBe(140);
    });

    it('user gets smaller dots instead of an overflowing rail', () => {
        const layout = resolveRailLayout({ itemCount: 70, availableHeight: 500 });

        expect(layout.itemSize).toBeLessThan(14);
        expect(layout.totalHeight).toBeLessThanOrEqual(500);
    });

    it('user never gets a rail taller than the window, even with hundreds of turns', () => {
        for (const itemCount of [120, 400, 2000]) {
            const layout = resolveRailLayout({ itemCount, availableHeight: 300 });

            expect(layout.totalHeight).toBeLessThanOrEqual(300);
            expect(layout.itemSize).toBeGreaterThan(0);
        }
    });

    it('user gets a rail that exactly fills a very short window', () => {
        const layout = resolveRailLayout({ itemCount: 40, availableHeight: 60 });

        expect(layout.totalHeight).toBeCloseTo(60, 5);
    });

    it('user gets the comfortable size before the rail has been measured', () => {
        expect(resolveRailLayout({ itemCount: 5, availableHeight: 0 }).itemSize).toBe(14);
        expect(resolveRailLayout({ itemCount: 0, availableHeight: 400 }).totalHeight).toBe(0);
    });
});
