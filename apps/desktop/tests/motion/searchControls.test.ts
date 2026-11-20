import { SegmentedControl } from '@components/ui/segmented-control';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import { provideMotionPreferences } from '@/composables/useMotion';
import type { AnimationSpeed } from '@/config/motion';
import SearchProviderCard from '@/views/SettingsView/components/Search/SearchProviderCard.vue';

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
let clock = 0;
let wrapper: ReturnType<typeof mount> | undefined;
let reduced = false;

beforeEach(() => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('matchMedia', () => ({
        matches: reduced,
        addEventListener() {},
        removeEventListener() {},
    }));
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
        this: HTMLElement
    ) {
        return this.tagName === 'BUTTON' ? (this.textContent?.length ?? 0) * 10 : 150;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
        this: HTMLElement
    ) {
        return this.previousElementSibling?.tagName === 'BUTTON'
            ? (this.previousElementSibling.textContent?.length ?? 0) * 10
            : 0;
    });
});

async function paint(count: number) {
    for (let i = 0; i < count; i++) {
        clock += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(clock));
        await nextTick();
    }
}

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await paint(20);
    reduced = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('given search controls share the window motion preferences', () => {
    it.each(['standard', 'faster'] as const)(
        'user opens a provider editor at the selected %s speed',
        async (speed) => {
            const editing = ref(false);
            wrapper = mount(
                defineComponent({
                    setup() {
                        provideMotionPreferences(ref<AnimationSpeed>(speed), ref(false));
                        return () =>
                            h(SearchProviderCard, {
                                id: 'test',
                                label: 'Engine',
                                description: 'Search',
                                logo: '/logo.svg',
                                enabled: true,
                                disabled: false,
                                editable: true,
                                editing: editing.value,
                                credential: '',
                                endpointValue: '',
                                endpointRequired: false,
                                supportsEndpoint: true,
                                supportsFetch: true,
                                fetchEnabled: true,
                                logoHasBackground: true,
                                endpointPlaceholder: '',
                                keyPlaceholder: '',
                                apiKeyRequired: false,
                            });
                    },
                })
            );
            await paint(4);
            const logo = wrapper.get('img').element.parentElement!.parentElement!;
            expect(Number.parseFloat(logo.style.width)).toBe(72);
            editing.value = true;
            await nextTick();
            await paint(40);
            const width = Number.parseFloat(logo.style.width);
            if (speed === 'faster') expect(width).toBe(28);
            else expect(width).toBeGreaterThan(28);
            await paint(30);
            expect(Number.parseFloat(logo.style.width)).toBe(28);
        }
    );

    it.each(['standard', 'faster'] as const)(
        'user sees the selection indicator travel at the selected %s speed',
        async (speed) => {
            const value = ref('key');
            wrapper = mount(
                defineComponent({
                    setup() {
                        provideMotionPreferences(ref<AnimationSpeed>(speed), ref(false));
                        return () =>
                            h(SegmentedControl, {
                                modelValue: value.value,
                                options: [
                                    { value: 'key', label: 'Key' },
                                    { value: 'url', label: 'URL' },
                                ],
                            });
                    },
                })
            );
            await paint(4);
            value.value = 'url';
            await nextTick();
            await paint(22);
            const indicator = wrapper.get('span').element;
            const position = () =>
                Number(indicator.style.transform.match(/translateX\(([-\d.]+)px\)/)?.[1] ?? 0);
            if (speed === 'faster') expect(position()).toBe(30);
            else expect(position()).toBeLessThan(30);
            await paint(10);
            expect(position()).toBe(30);
        }
    );

    it('user sees the indicator follow changed labels even when selection and total width stay unchanged', async () => {
        reduced = true;
        const options = ref([
            { value: 'key', label: 'Key' },
            { value: 'url', label: 'Base URL' },
        ]);
        wrapper = mount(
            defineComponent({
                setup() {
                    provideMotionPreferences(ref('standard'), ref(false));
                    return () => h(SegmentedControl, { modelValue: 'url', options: options.value });
                },
            })
        );
        await paint(4);
        const indicator = wrapper.get('span').element;
        expect(indicator.style.width).toBe('80px');
        options.value = [
            { value: 'key', label: 'API Key' },
            { value: 'url', label: 'URL ' },
        ];
        await nextTick();
        await paint(4);
        expect(indicator.style.width).toBe('40px');
        expect(indicator.style.transform).toContain('translateX(70px)');
    });
});
