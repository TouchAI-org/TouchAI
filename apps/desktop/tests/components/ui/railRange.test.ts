import { describe, expect, it, vi } from 'vitest';

import { resolveRailItemAtOffset } from '@/components/ui/message-scroller/railRange';

interface Item {
    id: string;
}

const ranges: Record<string, { top: number; bottom: number }> = {
    turn1: { top: 0, bottom: 400 },
    turn2: { top: 400, bottom: 2400 },
    turn3: { top: 2400, bottom: 2600 },
};

const items: Item[] = [{ id: 'turn1' }, { id: 'turn2' }, { id: 'turn3' }];
const resolveRange = (id: string) => ranges[id] ?? null;

describe('when the rail highlight follows the reading position', () => {
    it('user sees the turn whose prompt is on screen highlighted', () => {
        expect(resolveRailItemAtOffset(items, resolveRange, 120)).toBe('turn1');
    });

    it('user still sees that turn highlighted while reading deep inside a long answer', () => {
        // The answer of turn2 spans 2000px; the prompt sits at its top.
        for (const offset of [500, 1200, 2000, 2399]) {
            expect(resolveRailItemAtOffset(items, resolveRange, offset)).toBe('turn2');
        }
    });

    it('user sees the next turn once the answer has scrolled past', () => {
        expect(resolveRailItemAtOffset(items, resolveRange, 2450)).toBe('turn3');
    });

    it('user sees the nearest turn when the offset sits in a gap', () => {
        const withGap = (id: string) =>
            id === 'turn1'
                ? { top: 0, bottom: 100 }
                : id === 'turn2'
                  ? { top: 500, bottom: 600 }
                  : null;

        expect(resolveRailItemAtOffset(items, withGap, 320)).toBe('turn2');
    });

    it('user sees no highlight when no range can be measured yet', () => {
        const resolved = vi.fn(() => null);

        expect(resolveRailItemAtOffset(items, resolved, 500)).toBeNull();
    });

    it('user sees no highlight for an empty rail', () => {
        expect(resolveRailItemAtOffset([], resolveRange, 0)).toBeNull();
    });
});
