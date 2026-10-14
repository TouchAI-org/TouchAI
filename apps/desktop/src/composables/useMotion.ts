// Copyright (c) 2026. 千诚. Licensed under GPL v3
import { computed, onScopeDispose, ref } from 'vue';

/** CSS is the shared source of truth; motion-v consumes seconds. */
export function motionSeconds(value: string): number {
    const match = value.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/);
    if (!match) return 0;
    const number = Number(match[1]);
    return match[2] === 'ms' ? number / 1000 : number;
}

export function useMotion() {
    const media =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-reduced-motion: reduce)')
            : undefined;
    const reducedMotion = ref(media?.matches ?? false);
    const update = (event: MediaQueryListEvent) => {
        reducedMotion.value = event.matches;
    };
    media?.addEventListener('change', update);
    onScopeDispose(() => media?.removeEventListener('change', update));

    const transitions = computed(() => {
        const css =
            typeof document === 'undefined'
                ? undefined
                : getComputedStyle(document.documentElement);
        const values = css
            ?.getPropertyValue('--ease-smooth-out')
            .match(/[\d.]+/g)
            ?.map(Number);
        const ease =
            values?.length === 4
                ? (values as [number, number, number, number])
                : ('easeOut' as const);
        const preset = (token: string) => ({
            type: 'tween' as const,
            duration: reducedMotion.value ? 0 : motionSeconds(css?.getPropertyValue(token) ?? ''),
            ease,
        });
        return {
            quick: preset('--duration-quick'),
            fast: preset('--duration-fast'),
            slow: preset('--duration-slow'),
        };
    });
    return { reducedMotion, transitions };
}
