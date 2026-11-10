// Copyright (c) 2026. 千诚. Licensed under GPL v3
import { useStateMachine } from 'reka-ui';
import { onScopeDispose, readonly, type Ref, ref, watch } from 'vue';

const SAMPLE_INTERVAL_MS = 1000;
const LATE_SAMPLE_MS = 100;

/** Detect sustained contention in a visible renderer without a frame loop or native polling. */
export function useMotionPressure(
    enabled: Readonly<Ref<boolean>>,
    visible: Readonly<Ref<boolean>> = ref(true)
) {
    const pressured = ref(false);
    const lifecycle = useStateMachine('idle', {
        idle: { start: 'sampling', dispose: 'disposed' },
        sampling: { stop: 'idle', dispose: 'disposed' },
        disposed: {},
    });
    let samplingGeneration = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lateSamples = 0;
    let timelySamples = 0;

    function stop() {
        const stoppedGeneration = ++samplingGeneration;
        clearTimeout(timer);
        timer = undefined;
        lateSamples = timelySamples = 0;
        lifecycle.dispatch('stop');
        pressured.value = false;
        return stoppedGeneration;
    }

    function schedule(generation: number) {
        if (lifecycle.state.value !== 'sampling' || generation !== samplingGeneration) return;
        const expected = performance.now() + SAMPLE_INTERVAL_MS;
        timer = setTimeout(() => {
            if (lifecycle.state.value !== 'sampling' || generation !== samplingGeneration) return;
            timer = undefined;
            if (!enabled.value || !visible.value || document.hidden) {
                stop();
                return;
            }
            if (performance.now() - expected >= LATE_SAMPLE_MS) {
                timelySamples = 0;
                if (++lateSamples >= 2) pressured.value = true;
            } else {
                lateSamples = 0;
                if (++timelySamples >= 8) pressured.value = false;
            }
            schedule(generation);
        }, SAMPLE_INTERVAL_MS);
    }

    function restart() {
        if (lifecycle.state.value === 'disposed') return;
        const generation = stop();
        if (lifecycle.state.value !== 'idle' || generation !== samplingGeneration) return;
        if (enabled.value && visible.value && !document.hidden) {
            lifecycle.dispatch('start');
            schedule(generation);
        }
    }

    watch([enabled, visible], restart, { immediate: true, flush: 'sync' });
    document.addEventListener('visibilitychange', restart);
    onScopeDispose(() => {
        lifecycle.dispatch('dispose');
        stop();
        document.removeEventListener('visibilitychange', restart);
    });
    return readonly(pressured);
}
