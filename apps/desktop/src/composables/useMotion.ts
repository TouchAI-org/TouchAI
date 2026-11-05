// Copyright (c) 2026. 千诚. Licensed under GPL v3
import {
    computed,
    hasInjectionContext,
    inject,
    type InjectionKey,
    onScopeDispose,
    provide,
    type Ref,
    ref,
    watchEffect,
} from 'vue';

import { ANIMATION_SPEEDS, type AnimationSpeed, resolveMotionDuration } from '@/config/motion';

import { useMotionPressure } from './useMotionPressure';

interface MotionPolicy {
    reducedMotion: Readonly<Ref<boolean>>;
    duration: (milliseconds: number) => number;
}

const motionPolicyKey: InjectionKey<MotionPolicy> = Symbol('motion-policy');

/** CSS is the shared source of truth; motion-v consumes seconds. */
export function motionSeconds(value: string): number {
    const match = value.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/);
    if (!match) return 0;
    const number = Number(match[1]);
    return match[2] === 'ms' ? number / 1000 : number;
}

function useSystemReducedMotion() {
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
    return reducedMotion;
}

/** One policy per application window; all consumers share its preference and pressure signal. */
export function provideMotionPreferences(
    speed: Readonly<Ref<AnimationSpeed>>,
    automaticallyReduce: Readonly<Ref<boolean>>
) {
    const systemReduced = useSystemReducedMotion();
    const pressure = useMotionPressure(
        computed(() => automaticallyReduce.value && !systemReduced.value)
    );
    const reducedMotion = computed(() => systemReduced.value || pressure.value);
    const policy: MotionPolicy = {
        reducedMotion,
        duration: (milliseconds) =>
            resolveMotionDuration(milliseconds, speed.value, reducedMotion.value),
    };
    provide(motionPolicyKey, policy);

    const root = document.documentElement;
    watchEffect(
        () => {
            root.style.setProperty(
                '--motion-duration-scale',
                String(ANIMATION_SPEEDS[speed.value])
            );
            root.toggleAttribute('data-reduced-motion', reducedMotion.value);
        },
        { flush: 'sync' }
    );
    onScopeDispose(() => {
        root.style.removeProperty('--motion-duration-scale');
        root.removeAttribute('data-reduced-motion');
    });
    return policy;
}

export function useMotion() {
    const policy = hasInjectionContext() ? inject(motionPolicyKey, null) : null;
    const reducedMotion = policy?.reducedMotion ?? useSystemReducedMotion();
    const duration =
        policy?.duration ?? ((milliseconds: number) => (reducedMotion.value ? 0 : milliseconds));

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
            duration:
                duration(
                    motionSeconds(
                        css?.getPropertyValue(`${token}-base`) || css?.getPropertyValue(token) || ''
                    ) * 1000
                ) / 1000,
            ease,
        });
        return {
            quick: preset('--duration-quick'),
            fast: preset('--duration-fast'),
            slow: preset('--duration-slow'),
        };
    });
    return { reducedMotion, duration, transitions };
}
