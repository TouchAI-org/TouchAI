import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import BarChart from '@/components/ui/bar-chart/BarChart.vue';
import { provideMotionPreferences } from '@/composables/useMotion';
import type { AnimationSpeed } from '@/config/motion';

const data = [
    { key: 'a', label: 'A', values: { s: 3 } },
    { key: 'b', label: 'B', values: { s: 5 } },
];
const series = [{ key: 's', label: 'S' }];

describe('user opens a bar chart', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('user unmounts without leaving a pending frame behind', () => {
        const cancel = vi.fn();
        vi.stubGlobal('requestAnimationFrame', () => 42);
        vi.stubGlobal('cancelAnimationFrame', cancel);

        const wrapper = mount(BarChart, { props: { data, series, label: 'test' } });
        wrapper.unmount();

        // The pending frame must be cancelled, otherwise it writes to a dead ref.
        expect(cancel).toHaveBeenCalledWith(42);
    });

    it('user sees one path per visible segment', () => {
        const wrapper = mount(BarChart, { props: { data, series, label: 'test' } });

        expect(wrapper.findAll('svg path')).toHaveLength(data.length * series.length);
        wrapper.unmount();
    });

    it('user changes chart speed and stagger together', async () => {
        const speed = ref<AnimationSpeed>('slower');
        const wrapper = mount(
            defineComponent({
                setup() {
                    provideMotionPreferences(speed, ref(false));
                    return () => h(BarChart, { data, series, label: 'test' });
                },
            })
        );
        const secondBar = () =>
            (wrapper.findAll('g[style]')[1]!.element as SVGElement).style.transition;
        expect(secondBar()).toContain('744ms');
        expect(secondBar()).toContain('16.8ms');
        speed.value = 'faster';
        await nextTick();
        expect(secondBar()).toContain('403ms');
        expect(secondBar()).toContain('9.1ms');
        wrapper.unmount();
    });
});
