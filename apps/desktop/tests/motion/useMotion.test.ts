import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

import { motionSeconds, useMotion } from '@/composables/useMotion';

const mediaQuery = (matches = false) => {
    let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
    const media = {
        matches,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
            changeListener = listener;
        }),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
    return {
        media,
        emit(nextMatches: boolean) {
            changeListener?.({ matches: nextMatches } as MediaQueryListEvent);
        },
    };
};

afterEach(() => vi.unstubAllGlobals());

describe('motion composable', () => {
    it('converts CSS time tokens to seconds', () => {
        expect(motionSeconds('150ms')).toBe(0.15);
        expect(motionSeconds('0.4s')).toBe(0.4);
        expect(motionSeconds('invalid')).toBe(0);
    });

    it('tracks reduced-motion changes and removes the listener with the scope', () => {
        const query = mediaQuery();
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => query.media)
        );

        const scope = effectScope();
        let reducedMotion: ReturnType<typeof useMotion>['reducedMotion'] | undefined;
        scope.run(() => {
            reducedMotion = useMotion().reducedMotion;
        });

        expect(reducedMotion?.value).toBe(false);
        query.emit(true);
        expect(reducedMotion?.value).toBe(true);

        scope.stop();
        expect(query.media.removeEventListener).toHaveBeenCalledOnce();
    });
});
