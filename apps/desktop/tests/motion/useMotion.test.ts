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

describe('user sees motion follow the system preference', () => {
    it('user converts CSS time tokens to seconds', () => {
        expect(motionSeconds('150ms')).toBe(0.15);
        expect(motionSeconds('0.4s')).toBe(0.4);
        expect(motionSeconds('invalid')).toBe(0);
    });

    it('user tracks reduced-motion changes and removes the listener with the scope', () => {
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

describe('user sees motion durations taken from the stylesheet', () => {
    it('user gets the durations the CSS defines for each speed', () => {
        vi.stubGlobal(
            'getComputedStyle',
            vi.fn(() => ({
                getPropertyValue: (name: string) =>
                    ({
                        '--ease-smooth-out': '0.16 1 0.3 1',
                        '--duration-quick': '120ms',
                        '--duration-fast': '240ms',
                        '--duration-slow': '480ms',
                    })[name] ?? '',
            }))
        );
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => mediaQuery(false).media)
        );

        const scope = effectScope();
        const motion = scope.run(() => useMotion())!;

        // CSS owns the timing; the composable only converts it for motion-v.
        expect(motion.transitions.value.quick).toMatchObject({
            type: 'tween',
            duration: 0.12,
            ease: [0.16, 1, 0.3, 1],
        });
        expect(motion.transitions.value.slow.duration).toBe(0.48);

        scope.stop();
    });

    it('user gets the built-in ease when the stylesheet has no curve', () => {
        vi.stubGlobal(
            'getComputedStyle',
            vi.fn(() => ({
                getPropertyValue: (name: string) => (name === '--duration-quick' ? '100ms' : ''),
            }))
        );
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => mediaQuery(false).media)
        );

        const scope = effectScope();
        const motion = scope.run(() => useMotion())!;

        // A missing custom property must not produce NaN in the animation config.
        expect(motion.transitions.value.quick.ease).toBe('easeOut');
        expect(motion.transitions.value.fast.duration).toBe(0);

        scope.stop();
    });

    it('user gets no motion at all when they asked for reduced motion', () => {
        vi.stubGlobal(
            'getComputedStyle',
            vi.fn(() => ({
                getPropertyValue: (name: string) => (name === '--duration-quick' ? '120ms' : ''),
            }))
        );
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => mediaQuery(true).media)
        );

        const scope = effectScope();
        const motion = scope.run(() => useMotion())!;

        // Reduced motion means instant, whatever the stylesheet says.
        expect(motion.transitions.value.quick.duration).toBe(0);

        scope.stop();
    });
});
