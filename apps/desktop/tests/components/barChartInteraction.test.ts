import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BarChart from '@/components/ui/bar-chart/BarChart.vue';
import { setLocale } from '@/i18n';

/**
 * The bar chart is read by hovering a column and by arrowing through it with the keyboard.
 * The observable contract is what the reader gets: the breakdown, the column highlight, the
 * legend toggles and the annotations inside those.
 *
 * jsdom has no layout engine, so every element reports a zero-sized rect. The pointer math
 * needs a real width, so the plot rect is stubbed to a known size: mapping a position to a
 * column is the chart's job, measuring is the browser's.
 */

const PLOT_WIDTH = 400;
/** The chart lays out in its own viewBox units, independent of the measured width. */
const VIEW_WIDTH = 760;

const data = [
    { key: 'a', label: 'Monday', axisLabel: 'Mon', values: { desktop: 3, mobile: 2 } },
    { key: 'b', label: 'Tuesday', values: { desktop: 5, mobile: 1 } },
    { key: 'c', label: 'Wednesday', values: { desktop: 1, mobile: 4 } },
];

const series = [
    { key: 'desktop', label: 'Desktop' },
    { key: 'mobile', label: 'Mobile' },
];

function stubPlotRect(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: PLOT_WIDTH,
        bottom: 200,
        width: PLOT_WIDTH,
        height: 200,
        toJSON: () => ({}),
    } as DOMRect);
}

function mountChart(overrides: Record<string, unknown> = {}) {
    return mount(BarChart, {
        props: { data, series, label: 'Sessions per day', ...overrides },
        attachTo: document.body,
    });
}

function plot(wrapper: ReturnType<typeof mountChart>): HTMLElement {
    return wrapper.get('[role="application"]').element as HTMLElement;
}

/** X position that lands inside column `index` of the measured plot. */
function clientXOf(index: number): number {
    return Math.floor((PLOT_WIDTH * (index + 0.5)) / data.length);
}

function pointerMove(wrapper: ReturnType<typeof mountChart>, clientX: number): void {
    plot(wrapper).dispatchEvent(new MouseEvent('pointermove', { clientX, bubbles: true }));
}

async function keydown(wrapper: ReturnType<typeof mountChart>, key: string): Promise<void> {
    plot(wrapper).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await wrapper.vm.$nextTick();
}

function colourOf(element: Element): string {
    return (element as HTMLElement).style.backgroundColor;
}

describe('user hovers a column in the bar chart', () => {
    beforeEach(() => {
        setLocale('en-US');
        stubPlotRect();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('user sees the breakdown of the column under the pointer', async () => {
        const wrapper = mountChart();

        pointerMove(wrapper, clientXOf(0));
        await wrapper.vm.$nextTick();

        const tooltip = wrapper.get('[data-testid="bar-chart-tooltip"]');
        expect(tooltip.text()).toContain('Monday');
        expect(tooltip.text()).toContain('Desktop');
        expect(tooltip.text()).toContain('3');
        expect(tooltip.text()).toContain('Mobile');
        expect(tooltip.text()).toContain('2');

        wrapper.unmount();
    });

    it('user sees the hovered column highlighted behind its bars', async () => {
        const wrapper = mountChart();

        expect(wrapper.find('rect').exists()).toBe(false);

        pointerMove(wrapper, clientXOf(1));
        await wrapper.vm.$nextTick();

        const highlight = wrapper.get('rect');
        expect(highlight.attributes('fill')).toBe('currentColor');
        expect(highlight.attributes('width')).toBe(String(VIEW_WIDTH / data.length));

        wrapper.unmount();
    });

    it('user sees the total of the hovered column when more than one series is shown', async () => {
        const wrapper = mountChart({ formatValue: (value: number) => `${value} sessions` });

        pointerMove(wrapper, clientXOf(0));
        await wrapper.vm.$nextTick();

        const tooltip = wrapper.get('[data-testid="bar-chart-tooltip"]');
        // Monday: 3 desktop + 2 mobile.
        expect(tooltip.text()).toContain('5 sessions');
        expect(tooltip.text()).toContain('Total');

        wrapper.unmount();
    });

    it('user does not see a total row when only one series is on the chart', async () => {
        const wrapper = mountChart({ series: [series[0]] });

        pointerMove(wrapper, clientXOf(0));
        await wrapper.vm.$nextTick();

        const tooltip = wrapper.get('[data-testid="bar-chart-tooltip"]');
        expect(tooltip.text()).toContain('Desktop');
        expect(tooltip.text()).not.toContain('Total');

        wrapper.unmount();
    });

    it('user sees a missing series value counted as zero rather than leaving a gap', async () => {
        const wrapper = mountChart({
            data: [{ key: 'a', label: 'Monday', values: { desktop: 4 } }],
        });

        pointerMove(wrapper, 10);
        await wrapper.vm.$nextTick();

        const tooltip = wrapper.get('[data-testid="bar-chart-tooltip"]');
        expect(tooltip.text()).toContain('Mobile');
        expect(tooltip.text()).toContain('0');

        wrapper.unmount();
    });

    it('user sees the tooltip flip to the left of the last column so it is not clipped', async () => {
        const wrapper = mountChart();

        pointerMove(wrapper, PLOT_WIDTH - 1);
        await wrapper.vm.$nextTick();

        const style = wrapper.get('[data-testid="bar-chart-tooltip"]').attributes('style') ?? '';
        expect(style).toContain('margin-right: 8px');
        expect(style).not.toContain('margin-left');

        wrapper.unmount();
    });

    it('user sees the tooltip to the right of a column near the start', async () => {
        const wrapper = mountChart();

        pointerMove(wrapper, 1);
        await wrapper.vm.$nextTick();

        const style = wrapper.get('[data-testid="bar-chart-tooltip"]').attributes('style') ?? '';
        expect(style).toContain('margin-left: 8px');
        expect(style).not.toContain('margin-right');

        wrapper.unmount();
    });

    it('user sees the pointer past the left edge attributed to the first column', async () => {
        const wrapper = mountChart();

        pointerMove(wrapper, -50);
        await wrapper.vm.$nextTick();

        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Monday');

        wrapper.unmount();
    });

    it('user sees the pointer past the right edge attributed to the last column', async () => {
        const wrapper = mountChart();

        pointerMove(wrapper, PLOT_WIDTH + 500);
        await wrapper.vm.$nextTick();

        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Wednesday');

        wrapper.unmount();
    });

    it('user sees the breakdown and highlight disappear when the pointer leaves the chart', async () => {
        const wrapper = mountChart();

        pointerMove(wrapper, clientXOf(0));
        await wrapper.vm.$nextTick();
        expect(wrapper.find('[data-testid="bar-chart-tooltip"]').exists()).toBe(true);

        plot(wrapper).dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
        await wrapper.vm.$nextTick();

        expect(wrapper.find('[data-testid="bar-chart-tooltip"]').exists()).toBe(false);
        expect(wrapper.find('rect').exists()).toBe(false);

        wrapper.unmount();
    });
});

describe('user reads the bar chart with the keyboard', () => {
    beforeEach(() => {
        setLocale('en-US');
        stubPlotRect();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('user starts from the newest column when the first arrow key is pressed', async () => {
        const wrapper = mountChart();

        await keydown(wrapper, 'ArrowLeft');

        // No column is hovered yet, so the newest (rightmost) column is the anchor.
        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Tuesday');

        wrapper.unmount();
    });

    it('user does not see an arrow key scroll the page while reading the chart', async () => {
        const wrapper = mountChart();
        const event = new KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            bubbles: true,
            cancelable: true,
        });

        plot(wrapper).dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);

        wrapper.unmount();
    });

    it('user moves between columns with the left and right arrow keys', async () => {
        const wrapper = mountChart();

        await keydown(wrapper, 'ArrowLeft');
        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Tuesday');

        await keydown(wrapper, 'ArrowLeft');
        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Monday');

        await keydown(wrapper, 'ArrowRight');
        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Tuesday');

        await keydown(wrapper, 'ArrowRight');
        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Wednesday');

        wrapper.unmount();
    });

    it('user stays on the first column when pressing left again', async () => {
        const wrapper = mountChart();

        await keydown(wrapper, 'ArrowLeft');
        await keydown(wrapper, 'ArrowLeft');
        await keydown(wrapper, 'ArrowLeft');

        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Monday');

        wrapper.unmount();
    });

    it('user stays on the last column when pressing right again', async () => {
        const wrapper = mountChart();

        await keydown(wrapper, 'ArrowLeft');
        for (let press = 0; press < 10; press += 1) {
            await keydown(wrapper, 'ArrowRight');
        }

        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Wednesday');

        wrapper.unmount();
    });

    it('user dismisses the column breakdown with Escape', async () => {
        const wrapper = mountChart();

        await keydown(wrapper, 'ArrowLeft');
        expect(wrapper.find('[data-testid="bar-chart-tooltip"]').exists()).toBe(true);

        await keydown(wrapper, 'Escape');

        expect(wrapper.find('[data-testid="bar-chart-tooltip"]').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user does not see the breakdown change on an unrelated key', async () => {
        const wrapper = mountChart();

        await keydown(wrapper, 'ArrowLeft');
        await keydown(wrapper, 'Enter');

        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Tuesday');

        wrapper.unmount();
    });

    it('user keeps the column when a later hover lands where the pointer left off', async () => {
        const wrapper = mountChart();

        pointerMove(wrapper, clientXOf(2));
        await wrapper.vm.$nextTick();
        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Wednesday');

        // The keyboard continues from the hovered column rather than jumping back to the end.
        await keydown(wrapper, 'ArrowLeft');
        expect(wrapper.get('[data-testid="bar-chart-tooltip"]').text()).toContain('Tuesday');

        wrapper.unmount();
    });
});

describe('user filters the bar chart with the legend', () => {
    beforeEach(() => {
        setLocale('en-US');
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('user sees one toggle per series in the series colour', () => {
        const wrapper = mountChart();

        const toggles = wrapper.findAll('button');
        expect(toggles).toHaveLength(series.length);
        expect(toggles[0]!.text()).toBe('Desktop');
        expect(toggles[0]!.attributes('aria-pressed')).toBe('true');
        expect(colourOf(toggles[0]!.find('span').element)).toBe('rgb(63, 63, 70)');
        expect(colourOf(toggles[1]!.find('span').element)).toBe('rgb(14, 165, 233)');

        wrapper.unmount();
    });

    it('user sees a series colour the caller chose override the palette', () => {
        const wrapper = mountChart({
            series: [{ key: 'desktop', label: 'Desktop', color: 'hotpink' }],
        });

        expect(colourOf(wrapper.get('button span').element)).toBe('hotpink');

        wrapper.unmount();
    });

    it('user sees a series hidden and shown again by its legend toggle', async () => {
        const wrapper = mountChart();
        const [desktopToggle] = wrapper.findAll('button');

        await desktopToggle!.trigger('click');

        expect(desktopToggle!.attributes('aria-pressed')).toBe('false');
        expect(desktopToggle!.classes()).toContain('opacity-40');
        // One series remains, so each column is a single path.
        expect(wrapper.findAll('svg path')).toHaveLength(data.length);

        await desktopToggle!.trigger('click');

        expect(desktopToggle!.attributes('aria-pressed')).toBe('true');
        expect(desktopToggle!.classes()).toContain('opacity-100');
        expect(wrapper.findAll('svg path')).toHaveLength(data.length * series.length);

        wrapper.unmount();
    });

    it('user sees the breakdown of a hidden series removed from the tooltip', async () => {
        stubPlotRect();
        const wrapper = mountChart();
        const [, mobileToggle] = wrapper.findAll('button');

        await mobileToggle!.trigger('click');
        pointerMove(wrapper, clientXOf(0));
        await wrapper.vm.$nextTick();

        const tooltip = wrapper.get('[data-testid="bar-chart-tooltip"]');
        expect(tooltip.text()).toContain('Desktop');
        expect(tooltip.text()).not.toContain('Mobile');

        wrapper.unmount();
    });

    it('user does not see the legend when the chart is used as a bare graphic', () => {
        const wrapper = mountChart({ legend: false });

        expect(wrapper.find('button').exists()).toBe(false);
        expect(wrapper.find('svg').exists()).toBe(true);

        wrapper.unmount();
    });
});

describe('user reads an empty bar chart', () => {
    beforeEach(() => {
        setLocale('en-US');
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('user sees the empty message instead of a plot with no bars', () => {
        const wrapper = mountChart({ data: [], emptyLabel: 'No sessions yet' });

        expect(wrapper.text()).toContain('No sessions yet');
        expect(wrapper.find('svg').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user sees no average line on an empty chart', () => {
        const wrapper = mountChart({ data: [], emptyLabel: 'Nothing' });

        expect(wrapper.findAll('line')).toHaveLength(0);

        wrapper.unmount();
    });

    it('user sees the empty message at the height they asked for', () => {
        const wrapper = mountChart({ data: [], emptyLabel: 'Nothing', height: 240 });

        const emptyState = wrapper.get('div[style*="240px"]');
        expect(emptyState.text()).toContain('Nothing');

        wrapper.unmount();
    });
});

describe('user reads the bar chart annotations', () => {
    beforeEach(() => {
        setLocale('en-US');
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('user sees the mean of the column totals marked with a dashed line and its value', () => {
        // Ticks are whole numbers while the mean is not, so the mean label is unique.
        const wrapper = mountChart({
            formatTick: (value: number) => String(Math.round(value * 10) / 10),
        });

        const dashed = wrapper
            .findAll('line')
            .filter((line) => line.attributes('stroke-dasharray') === '3 3');
        expect(dashed).toHaveLength(1);

        // Monday 5, Tuesday 6, Wednesday 5 => 5.3.
        expect(wrapper.findAll('text').map((node) => node.text())).toContain('5.3');

        wrapper.unmount();
    });

    it('user does not see an average line when the caller turned it off', () => {
        const wrapper = mountChart({ showAverage: false });
        const dashed = wrapper
            .findAll('line')
            .filter((line) => line.attributes('stroke-dasharray') === '3 3');

        expect(dashed).toHaveLength(0);

        wrapper.unmount();
    });

    it('user sees the axis labels the caller supplied instead of the full day names', () => {
        const wrapper = mountChart();
        const texts = wrapper.findAll('text').map((node) => node.text());

        // Only some columns are labelled, but the supplied short label wins over the full one.
        expect(texts).toContain('Mon');
        expect(texts).not.toContain('Monday');

        wrapper.unmount();
    });

    it('user sees the tick labels formatted with the caller formatter', () => {
        const wrapper = mountChart({ formatTick: (value: number) => `${value}k` });

        const tickTexts = wrapper
            .findAll('[aria-hidden="true"] span')
            .map((node) => node.text())
            .filter(Boolean);

        expect(tickTexts.length).toBeGreaterThan(0);
        for (const tick of tickTexts) {
            expect(tick).toMatch(/k$/);
        }

        wrapper.unmount();
    });

    it('user sees the axis values formatted with the value formatter when no tick formatter was given', () => {
        const wrapper = mountChart({ formatValue: (value: number) => `<${value}>` });

        const tickTexts = wrapper
            .findAll('[aria-hidden="true"] span')
            .map((node) => node.text())
            .filter(Boolean);

        expect(tickTexts.some((text) => text.startsWith('<') && text.endsWith('>'))).toBe(true);

        wrapper.unmount();
    });

    it('user sees the grid line for every axis tick', () => {
        const wrapper = mountChart({
            formatTick: (value: number) => `${value}`,
        });
        const solidLines = wrapper
            .findAll('line')
            .filter(
                (line) =>
                    line.attributes('stroke-width') === '1' &&
                    line.attributes('stroke-dasharray') === undefined
            );

        // One grid line per tick plus the baseline that closes the plot.
        const tickCount = wrapper.findAll('[aria-hidden="true"] span').length;
        expect(tickCount).toBeGreaterThan(1);
        expect(solidLines).toHaveLength(tickCount + 1);

        wrapper.unmount();
    });

    it('user sees bars start from the baseline before the first frame', () => {
        vi.stubGlobal('requestAnimationFrame', () => 7);
        const wrapper = mountChart();
        const groups = wrapper.findAll('svg g[style]');

        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) {
            expect(group.attributes('style')).toContain('scaleY(0)');
        }

        wrapper.unmount();
    });

    it('user sees bars at full height after the first frame', async () => {
        const wrapper = mountChart();

        await wrapper.vm.$nextTick();

        const groups = wrapper.findAll('svg g[style]');
        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) {
            expect(group.attributes('style')).toContain('scaleY(1)');
        }

        wrapper.unmount();
    });

    it('user sees the growth of each bar staggered left to right but capped', () => {
        const wrapper = mountChart({
            data: Array.from({ length: 20 }, (_value, index) => ({
                key: `d${index}`,
                label: `Day ${index}`,
                values: { desktop: 1 },
            })),
            series: [series[0]],
        });

        const styles = wrapper
            .findAll('svg g[style]')
            .map((group) => group.attributes('style') ?? '');

        expect(styles[0]).toContain('0ms');
        expect(styles[1]).toContain('14ms');
        // 20 * 14 = 280ms, but the stagger stops at 240ms so the last bars are not far behind.
        expect(styles[styles.length - 1]).toContain('240ms');

        wrapper.unmount();
    });

    it('user sees a column with no positive value drawn with no bars', () => {
        const wrapper = mountChart({
            data: [
                { key: 'a', label: 'Monday', values: { desktop: 0, mobile: 0 } },
                { key: 'b', label: 'Tuesday', values: { desktop: 5, mobile: 0 } },
            ],
        });

        // The empty column contributes no path at all; only Tuesday's segment is drawn.
        expect(wrapper.findAll('svg path')).toHaveLength(1);

        wrapper.unmount();
    });
});
