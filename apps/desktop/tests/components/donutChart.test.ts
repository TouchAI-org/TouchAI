import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DonutChart from '@/components/ui/donut-chart/DonutChart.vue';
import { setLocale } from '@/i18n';

/*
 * The donut chart is a reading aid: a legend a user can hover or pin, a centre
 * readout that follows whichever slice is active, and an empty ring when there is
 * nothing to show. Every assertion below reads that rendered output. The geometry
 * maths has its own test; this file drives the component around it.
 */

const data = [
    { key: 'gpt-5', label: 'GPT 5', value: 60 },
    { key: 'claude', label: 'Claude', value: 30 },
    { key: 'gemini', label: 'Gemini', value: 10 },
];

function mountChart(props: Record<string, unknown> = {}) {
    const wrapper = mount(DonutChart, { props: { data, ...props } });
    pumpFrames();
    return wrapper;
}

type Wrapper = ReturnType<typeof mountChart>;

function legendButtons(wrapper: Wrapper) {
    return wrapper.findAll('ul button');
}

function centre(wrapper: Wrapper) {
    return wrapper.get('.absolute.top-1\\/2');
}

function paths(wrapper: Wrapper) {
    return wrapper.findAll('path');
}

/*
 * jsdom has no animation frames. Calling the callback straight from rAF would
 * recurse forever (each frame schedules the next), so the stub queues frames and
 * a helper drains a bounded number of them — enough for the spring to settle.
 */
let frames: FrameRequestCallback[] = [];
let frameTime = 0;

function pumpFrames(count = 200) {
    for (let index = 0; index < count && frames.length > 0; index += 1) {
        const pending = frames;
        frames = [];
        frameTime += 16;
        for (const callback of pending) callback(frameTime);
    }
}

beforeEach(() => {
    setLocale('zh-CN');
    frames = [];
    frameTime = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
        frames = [];
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('user reads the composition at a glance', () => {
    it('user sees one legend row per slice with its share', async () => {
        const wrapper = mountChart();
        await flushPromises();

        const rows = legendButtons(wrapper);
        expect(rows).toHaveLength(3);
        expect(rows[0]!.text()).toContain('GPT 5');
        expect(rows[0]!.text()).toContain('60.0%');
        expect(rows[2]!.text()).toContain('10.0%');
    });

    it('user sees the total in the middle before touching anything', async () => {
        const wrapper = mountChart({ totalLabel: '总消耗' });
        await flushPromises();

        expect(centre(wrapper).text()).toContain('100');
        expect(centre(wrapper).text()).toContain('总消耗');
    });

    it('user sees no caption when the caller gave none', async () => {
        const wrapper = mountChart();
        await flushPromises();

        expect(centre(wrapper).text()).toContain('100');
        expect(centre(wrapper).text()).not.toContain('总消耗');
    });

    it('user gets the values formatted the way the caller asked', async () => {
        const wrapper = mountChart({ formatValue: (value: number) => `${value} tok` });
        await flushPromises();

        expect(legendButtons(wrapper)[0]!.text()).toContain('60 tok');
    });

    it('user gets an approximate mark on values the caller says are estimated', async () => {
        const wrapper = mountChart({ estimatedKeys: ['claude'] });
        await flushPromises();

        expect(legendButtons(wrapper)[1]!.text()).toContain('≈');
        expect(legendButtons(wrapper)[0]!.text()).not.toContain('≈');
    });

    it('user gets an empty ring instead of a broken chart when there is no data', async () => {
        const wrapper = mountChart({ data: [] });
        await flushPromises();

        expect(wrapper.find('circle').exists()).toBe(true);
        expect(paths(wrapper)).toHaveLength(0);
        expect(legendButtons(wrapper)).toHaveLength(0);
    });

    it('user gets a zero readout for an empty chart rather than a crash', async () => {
        const wrapper = mountChart({ data: [] });
        await flushPromises();

        expect(centre(wrapper).text()).toContain('0');
    });

    it('user can hide the legend and keep the ring', async () => {
        const wrapper = mountChart({ legend: false });
        await flushPromises();

        expect(wrapper.find('ul').exists()).toBe(false);
        expect(paths(wrapper).length).toBeGreaterThan(0);
    });

    it('user gets the ring labelled for a screen reader from the caption', async () => {
        const wrapper = mountChart({ totalLabel: '总消耗' });
        await flushPromises();

        expect(wrapper.get('svg').attributes('aria-label')).toBe('总消耗');
    });
});

describe('user inspects one slice', () => {
    it('user gets the slice name, value and share when hovering its legend row', async () => {
        const wrapper = mountChart({ totalLabel: '总消耗' });
        await flushPromises();

        await legendButtons(wrapper)[1]!.trigger('mouseenter');

        expect(centre(wrapper).text()).toContain('Claude');
        expect(centre(wrapper).text()).toContain('30');
        expect(centre(wrapper).text()).toContain('30.0%');
        expect(centre(wrapper).text()).not.toContain('总消耗');
    });

    it('user gets the total back when the pointer leaves', async () => {
        const wrapper = mountChart({ totalLabel: '总消耗' });
        await flushPromises();
        await legendButtons(wrapper)[1]!.trigger('mouseenter');

        await legendButtons(wrapper)[1]!.trigger('mouseleave');

        expect(centre(wrapper).text()).toContain('总消耗');
    });

    it('user gets the slice highlighted on the ring when hovering it', async () => {
        const wrapper = mountChart();
        await flushPromises();

        await paths(wrapper)[1]!.trigger('mouseenter');

        expect(centre(wrapper).text()).toContain('Claude');
    });

    it('user gets the other slices dimmed while one is active', async () => {
        const wrapper = mountChart();
        await flushPromises();

        await paths(wrapper)[0]!.trigger('mouseenter');
        pumpFrames();
        await flushPromises();

        const opacities = paths(wrapper).map((node) => node.attributes('opacity'));
        expect(opacities[0]).toBe('1');
        expect(opacities[1]).toBe('0.45');
        expect(opacities[2]).toBe('0.45');
    });

    it('user gets every slice back to full strength when the pointer leaves the ring', async () => {
        const wrapper = mountChart();
        await flushPromises();
        await paths(wrapper)[0]!.trigger('mouseenter');

        await paths(wrapper)[0]!.trigger('mouseleave');
        pumpFrames();
        await flushPromises();

        expect(paths(wrapper).map((node) => node.attributes('opacity'))).toEqual(['1', '1', '1']);
    });

    it('user gets the slice pinned by clicking its legend row', async () => {
        const wrapper = mountChart({ totalLabel: '总消耗' });
        await flushPromises();

        await legendButtons(wrapper)[2]!.trigger('click');

        expect(centre(wrapper).text()).toContain('Gemini');
        expect(legendButtons(wrapper)[2]!.attributes('aria-pressed')).toBe('true');
    });

    it('user gets the pin released by clicking the same row again', async () => {
        const wrapper = mountChart({ totalLabel: '总消耗' });
        await flushPromises();
        await legendButtons(wrapper)[2]!.trigger('click');

        await legendButtons(wrapper)[2]!.trigger('click');

        expect(legendButtons(wrapper)[2]!.attributes('aria-pressed')).toBe('false');
        expect(centre(wrapper).text()).toContain('总消耗');
    });

    it('user gets the pin moved when they click a different row', async () => {
        const wrapper = mountChart();
        await flushPromises();
        await legendButtons(wrapper)[0]!.trigger('click');

        await legendButtons(wrapper)[1]!.trigger('click');

        expect(legendButtons(wrapper)[0]!.attributes('aria-pressed')).toBe('false');
        expect(legendButtons(wrapper)[1]!.attributes('aria-pressed')).toBe('true');
        expect(centre(wrapper).text()).toContain('Claude');
    });

    it('user gets the hover preview back over the pinned slice when they move away', async () => {
        const wrapper = mountChart();
        await flushPromises();
        await legendButtons(wrapper)[0]!.trigger('click');

        await legendButtons(wrapper)[2]!.trigger('mouseenter');
        expect(centre(wrapper).text()).toContain('Gemini');

        await legendButtons(wrapper)[2]!.trigger('mouseleave');
        expect(centre(wrapper).text()).toContain('GPT 5');
    });
});

describe('user reads a chart with many small slices', () => {
    const many = [
        { key: 'a', label: 'A', value: 70 },
        { key: 'b', label: 'B', value: 10 },
        { key: 'c', label: 'C', value: 8 },
        { key: 'd', label: 'D', value: 6 },
        { key: 'e', label: 'E', value: 4 },
        { key: 'f', label: 'F', value: 1 },
        { key: 'g', label: 'G', value: 1 },
    ];

    it('user gets the small slices folded into one "other" row', async () => {
        const wrapper = mountChart({ data: many });
        await flushPromises();

        const labels = legendButtons(wrapper).map((node) => node.text());
        expect(labels.some((text) => text.includes('其他'))).toBe(true);
    });

    it('user still sees the whole total, folded or not', async () => {
        const wrapper = mountChart({ data: many });
        await flushPromises();

        expect(centre(wrapper).text()).toContain('100');
    });

    it('user gets a "other" row that can be pinned like any other', async () => {
        const wrapper = mountChart({ data: many });
        await flushPromises();
        const otherRow = legendButtons(wrapper).find((node) => node.text().includes('其他'))!;

        await otherRow.trigger('click');

        expect(otherRow.attributes('aria-pressed')).toBe('true');
    });

    it('user gets every slice kept when they raise the folding threshold to zero', async () => {
        const wrapper = mountChart({ data: many, groupBelow: 0, maxSegments: 10 });
        await flushPromises();

        expect(legendButtons(wrapper)).toHaveLength(many.length);
    });
});

describe('user gets a stable colour per item', () => {
    it('user gets an explicit colour used when the caller supplies one', async () => {
        const wrapper = mountChart({
            data: [
                { key: 'a', label: 'A', value: 1, color: 'rgb(1 2 3)' },
                { key: 'b', label: 'B', value: 1 },
            ],
        });
        await flushPromises();

        expect(paths(wrapper)[0]!.attributes('fill')).toBe('rgb(1 2 3)');
        expect(paths(wrapper)[1]!.attributes('fill')).not.toBe('rgb(1 2 3)');
    });

    it('user gets the same colour for an item after the data is reordered', async () => {
        const wrapper = mountChart();
        await flushPromises();
        const before = legendButtons(wrapper)[0]!.find('span').attributes('style');

        await wrapper.setProps({ data: [...data].reverse() });
        await flushPromises();
        pumpFrames();

        const reordered = legendButtons(wrapper).find((node) => node.text().includes('GPT 5'))!;
        expect(reordered.find('span').attributes('style')).toBe(before);
    });

    it('user gets a new item coloured without disturbing the others', async () => {
        const wrapper = mountChart();
        await flushPromises();
        const claudeColour = legendButtons(wrapper)[1]!.find('span').attributes('style');

        await wrapper.setProps({
            data: [...data, { key: 'llama', label: 'Llama', value: 5 }],
        });
        await flushPromises();
        pumpFrames();

        const claudeRow = legendButtons(wrapper).find((node) => node.text().includes('Claude'))!;
        expect(claudeRow.find('span').attributes('style')).toBe(claudeColour);
    });
});

describe('user resizes the ring', () => {
    it('user gets the ring drawn at the size they asked for', async () => {
        const wrapper = mountChart({ size: 240 });
        await flushPromises();

        expect(wrapper.get('svg').attributes('viewBox')).toBe('0 0 240 240');
    });

    it('user gets the centre readout shrinking for a long value so it stays inside the hole', async () => {
        const wrapper = mountChart({
            size: 160,
            data: [{ key: 'a', label: 'A', value: 1 }],
            formatValue: () => '148.6万',
        });
        await flushPromises();

        const value = wrapper.get('.font-serif.leading-tight');
        const size = Number(/font-size: (\d+)px/.exec(value.attributes('style') ?? '')?.[1] ?? 0);
        expect(size).toBeGreaterThan(0);
        expect(size).toBeLessThanOrEqual(16);
    });

    it('user gets a wider centre readout for a short value', async () => {
        const short = mountChart({ formatValue: () => '7' });
        const long = mountChart({ formatValue: () => '148.6万' });
        await flushPromises();

        const sizeOf = (wrapper: Wrapper) =>
            Number(
                /font-size: (\d+)px/.exec(
                    wrapper.get('.font-serif.leading-tight').attributes('style') ?? ''
                )?.[1] ?? 0
            );
        expect(sizeOf(short)).toBeGreaterThanOrEqual(sizeOf(long));
    });
});

describe('user leaves the chart', () => {
    it('user gets a clean teardown with no frames left to run', async () => {
        const wrapper = mountChart();
        await flushPromises();
        // A hover leaves an animation in flight when the chart disappears.
        await paths(wrapper)[0]!.trigger('mouseenter');

        wrapper.unmount();

        expect(frames).toHaveLength(0);
    });

    it('user gets nothing painted after the chart is gone', async () => {
        const wrapper = mountChart();
        await flushPromises();
        await paths(wrapper)[0]!.trigger('mouseenter');

        wrapper.unmount();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        pumpFrames();

        // Draining the queue must not reach into a destroyed component.
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
    });
});
