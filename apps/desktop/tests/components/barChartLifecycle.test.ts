import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BarChart from '@/components/ui/bar-chart/BarChart.vue';

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
});
