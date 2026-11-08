import {
    applyPersistedGeneralSettingValue,
    createDefaultGeneralSettings,
    serializeGeneralSetting,
} from '@services/SettingsService/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, watch } from 'vue';

import { useMotionPressure } from '@/composables/useMotionPressure';
import { normalizeAnimationSpeed, resolveMotionDuration } from '@/config/motion';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('user adjusts motion preferences', () => {
    it('user keeps standard motion when a saved speed is missing or invalid', () => {
        expect(normalizeAnimationSpeed(null)).toBe('standard');
        expect(normalizeAnimationSpeed('invalid')).toBe('standard');
        const settings = createDefaultGeneralSettings();
        expect(settings.animationSpeed).toBe('standard');
        expect(settings.automaticallyReduceMotion).toBe(true);
        applyPersistedGeneralSettingValue(settings, 'animation_speed', 'faster');
        applyPersistedGeneralSettingValue(settings, 'automatically_reduce_motion', 'false');
        expect(serializeGeneralSetting(settings, 'animation_speed')).toBe('faster');
        expect(serializeGeneralSetting(settings, 'automatically_reduce_motion')).toBe('false');
    });

    it('user gets the chosen speed while reduced motion takes precedence', () => {
        expect(resolveMotionDuration(320, 'slower', false)).toBe(384);
        expect(resolveMotionDuration(320, 'standard', false)).toBe(320);
        expect(resolveMotionDuration(320, 'faster', false)).toBe(208);
        expect(resolveMotionDuration(320, 'slower', true)).toBe(0);
    });
});

describe('user enables automatic motion reduction', () => {
    it('user loses animation only after sustained delays and regains it after a stable recovery', async () => {
        vi.useFakeTimers();
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        const enabled = ref(true);
        const scope = effectScope();
        const pressure = scope.run(() => useMotionPressure(enabled))!;
        const sample = async (elapsed: number) => {
            clock += elapsed;
            await vi.advanceTimersByTimeAsync(1000);
        };
        await sample(1200);
        expect(pressure.value).toBe(false);
        await sample(1200);
        expect(pressure.value).toBe(true);
        for (let i = 0; i < 7; i++) await sample(1000);
        expect(pressure.value).toBe(true);
        await sample(1000);
        expect(pressure.value).toBe(false);
        scope.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('user has no background monitoring when disabled or hidden', async () => {
        vi.useFakeTimers();
        let hidden = false;
        vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
        const enabled = ref(true);
        const scope = effectScope();
        const pressure = scope.run(() => useMotionPressure(enabled))!;
        expect(vi.getTimerCount()).toBe(1);
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(vi.getTimerCount()).toBe(0);
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(vi.getTimerCount()).toBe(1);
        enabled.value = false;
        await nextTick();
        expect(pressure.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        scope.stop();
    });

    it('user regains normal motion when the native window returns even if the document stayed visible', async () => {
        vi.useFakeTimers();
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        const visible = ref(true);
        const scope = effectScope();
        const pressure = scope.run(() => useMotionPressure(ref(true), visible))!;
        for (let index = 0; index < 2; index += 1) {
            clock += 1200;
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(pressure.value).toBe(true);
        visible.value = false;
        expect(pressure.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        clock += 300000;
        visible.value = true;
        clock += 1000;
        await vi.advanceTimersByTimeAsync(1000);
        expect(pressure.value).toBe(false);
        scope.stop();
    });

    it('user disposes the motion policy during pressure feedback and no background sampling survives', async () => {
        vi.useFakeTimers();
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        const scope = effectScope();
        const pressure = scope.run(() => {
            const currentPressure = useMotionPressure(ref(true));
            watch(
                currentPressure,
                (active) => {
                    if (active) scope.stop();
                },
                { flush: 'sync' }
            );
            return currentPressure;
        })!;

        try {
            for (let sample = 0; sample < 2; sample += 1) {
                clock += 1200;
                await vi.advanceTimersByTimeAsync(1000);
            }
            expect(pressure.value).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            scope.stop();
            vi.clearAllTimers();
        }
    });

    it('user restarts monitoring during pressure feedback and one late sample does not reduce motion', async () => {
        vi.useFakeTimers();
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        const enabled = ref(true);
        const scope = effectScope();
        let restarted = false;
        const pressure = scope.run(() => {
            const currentPressure = useMotionPressure(enabled);
            watch(
                currentPressure,
                (active) => {
                    if (!active || restarted) return;
                    restarted = true;
                    enabled.value = false;
                    enabled.value = true;
                },
                { flush: 'sync' }
            );
            return currentPressure;
        })!;

        try {
            for (let sample = 0; sample < 2; sample += 1) {
                clock += 1200;
                await vi.advanceTimersByTimeAsync(1000);
            }
            expect(pressure.value).toBe(false);
            clock += 1200;
            await vi.advanceTimersByTimeAsync(1000);
            expect(pressure.value).toBe(false);
        } finally {
            scope.stop();
            vi.clearAllTimers();
        }
    });

    it('user refreshes visibility during recovery feedback and only one sampler remains', async () => {
        vi.useFakeTimers();
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        const scope = effectScope();
        const pressure = scope.run(() => useMotionPressure(ref(true)))!;

        try {
            for (let sample = 0; sample < 2; sample += 1) {
                clock += 1200;
                await vi.advanceTimersByTimeAsync(1000);
            }
            expect(pressure.value).toBe(true);
            scope.run(() => {
                watch(
                    pressure,
                    (active) => {
                        if (!active) document.dispatchEvent(new Event('visibilitychange'));
                    },
                    { flush: 'sync' }
                );
            });
            document.dispatchEvent(new Event('visibilitychange'));
            expect(pressure.value).toBe(false);
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            scope.stop();
            vi.clearAllTimers();
        }
    });
});
