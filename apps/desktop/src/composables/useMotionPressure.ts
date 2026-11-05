// Copyright (c) 2026. 千诚. Licensed under GPL v3
import { onScopeDispose, readonly, type Ref, ref, watch } from 'vue';

const SAMPLE_INTERVAL_MS = 1000;
const LATE_SAMPLE_MS = 100;

/** Detect sustained contention in a visible renderer without a frame loop or native polling. */
export function useMotionPressure(enabled: Readonly<Ref<boolean>>) {
    const pressured = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lateSamples = 0;
    let timelySamples = 0;

    function stop() {
        clearTimeout(timer);
        timer = undefined;
        lateSamples = timelySamples = 0;
        pressured.value = false;
    }

    function schedule() {
        const expected = performance.now() + SAMPLE_INTERVAL_MS;
        timer = setTimeout(() => {
            if (!enabled.value || document.hidden) {
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
            schedule();
        }, SAMPLE_INTERVAL_MS);
    }

    function restart() {
        stop();
        if (enabled.value && !document.hidden) schedule();
    }

    watch(enabled, restart, { immediate: true, flush: 'sync' });
    document.addEventListener('visibilitychange', restart);
    onScopeDispose(() => {
        stop();
        document.removeEventListener('visibilitychange', restart);
    });
    return readonly(pressured);
}
