import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

import { useMotionPressure } from '@/composables/useMotionPressure';
import { normalizeAnimationSpeed, resolveMotionDuration } from '@/config/motion';
import {
    applyPersistedGeneralSettingValue,
    createDefaultGeneralSettings,
    serializeGeneralSetting,
} from '@/stores/setting';

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
});
