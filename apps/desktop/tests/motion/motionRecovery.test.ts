import { mount } from '@vue/test-utils';
import { motion } from 'motion-v';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import App from '@/App.vue';
import { useMotion } from '@/composables/useMotion';
import { setActiveSettingsService } from '@/services/SettingsService';
import { useSettingsStore } from '@/stores/settings';

import { mockTauriCommand } from '../utils/tauri';

// motion-v captures the frame scheduler on import. Keep the real animation engine,
// while controlling its clock and frames instead of waiting for wall-clock animation.
const { frames } = vi.hoisted(() => {
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    globalThis.requestAnimationFrame = (callback) => {
        frames.set(++sequence, callback);
        return sequence;
    };
    globalThis.cancelAnimationFrame = (id) => {
        frames.delete(id);
    };
    return { frames };
});

vi.mock('@components/AppUpdateRequiredGate.vue', () => ({ default: { render: () => null } }));

let wrapper: ReturnType<typeof mount> | undefined;
let pinia: ReturnType<typeof createPinia> | undefined;
let clock = 0;
let systemReduced = false;
const listeners = new Set<(event: { matches: boolean }) => void>();

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('matchMedia', () => ({
        matches: systemReduced,
        addEventListener: (_: string, callback: (event: { matches: boolean }) => void) =>
            listeners.add(callback),
        removeEventListener: (_: string, callback: (event: { matches: boolean }) => void) =>
            listeners.delete(callback),
    }));
    document.documentElement.style.setProperty('--duration-fast-base', '250ms');
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    if (pinia) disposePinia(pinia);
    pinia = undefined;
    setActiveSettingsService(null);
    await paint(20);
    listeners.clear();
    systemReduced = false;
    document.documentElement.style.removeProperty('--duration-fast-base');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function sample(elapsed: number) {
    clock += elapsed;
    await vi.advanceTimersByTimeAsync(1000);
}

async function paint(count: number) {
    for (let i = 0; i < count; i++) {
        clock += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(clock));
        await nextTick();
    }
}

describe('user recovers motion without reopening a surface', () => {
    it.each(['automatic', 'system'] as const)(
        'user animates an element mounted during %s reduction after recovery',
        async (mode) => {
            pinia = createPinia();
            const store = useSettingsStore(pinia);
            mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
            await store.initialize();
            store.settings.automaticallyReduceMotion = mode === 'automatic';
            systemReduced = mode === 'system';
            const shown = ref(false);
            const x = ref(0);
            const Child = defineComponent({
                setup() {
                    const { transitions } = useMotion();
                    return () =>
                        h(motion.div, {
                            'data-probe': true,
                            layout: 'position',
                            initial: false,
                            animate: { x: x.value },
                            transition: transitions.value.fast,
                        });
                },
            });
            const Screen = defineComponent({
                setup: () => {
                    useMotion().setWindowVisible(true);
                    return () => (shown.value ? h(Child) : null);
                },
            });
            wrapper = mount(App, {
                attachTo: document.body,
                global: { plugins: [pinia], stubs: { 'router-view': Screen } },
            });
            if (mode === 'automatic') {
                await sample(1200);
                await sample(1200);
            }
            expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true);
            shown.value = true;
            await nextTick();
            const element = wrapper.get('[data-probe]').element as HTMLElement;
            const position = () =>
                Number(element.style.transform.match(/translateX\(([-\d.]+)px\)/)?.[1] ?? 0);
            x.value = 20;
            await nextTick();
            await paint(4);
            expect(position()).toBe(20);

            if (mode === 'automatic') {
                for (let i = 0; i < 8; i++) await sample(1000);
            } else {
                listeners.forEach((listener) => listener({ matches: false }));
                await nextTick();
            }
            expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false);
            expect(wrapper.get('[data-probe]').element).toBe(element);
            x.value = 100;
            await nextTick();
            await paint(4);
            expect(position()).toBeGreaterThan(20);
            expect(position()).toBeLessThan(100);
            await paint(20);
            expect(position()).toBe(100);
        }
    );
});
