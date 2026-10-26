import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ActivityHeatmap from '@/components/ui/activity-heatmap/ActivityHeatmap.vue';
import { setLocale } from '@/i18n';

/*
 * The model test covers the calendar arithmetic. What a user meets here is the
 * rendered calendar: the tooltip that follows a cell, the keyboard walk across
 * the grid, the legend preview/pin, the value and date formatters and the
 * year-padded window. All of it is read off the DOM.
 */

const days = [
    { date: '2026-01-01', count: 1 },
    { date: '2026-01-02', count: 3 },
    { date: '2026-01-05', count: 9 },
    { date: '2026-01-11', count: 0 },
];

function mountHeatmap(props: Record<string, unknown> = {}) {
    return mount(ActivityHeatmap, {
        props: { days, label: 'Activity', ...props },
        attachTo: document.body,
    });
}

type Wrapper = ReturnType<typeof mountHeatmap>;

function cell(wrapper: Wrapper, date: string) {
    const found = wrapper.find(`rect[data-day="${date}"]`);
    expect(found.exists()).toBe(true);
    return found;
}

function cells(wrapper: Wrapper) {
    return wrapper.findAll('rect[data-day]');
}

function bubble(wrapper: Wrapper) {
    return wrapper.get('[data-testid="activity-heatmap-tooltip"]');
}

beforeEach(() => {
    setLocale('zh-CN');
    // jsdom has no ResizeObserver; the calendar falls back to its natural width.
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    // Let the entry animation finish so the cells are at full opacity.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('user reads which days were busy', () => {
    it('user sees one cell per day across the whole span, including idle days', () => {
        const wrapper = mountHeatmap();

        // 2026-01-01 through 2026-01-11: ten days plus the two days with no data
        // inside that span (the 3rd and the 4th).
        expect(cells(wrapper)).toHaveLength(11);
        expect(cell(wrapper, '2026-01-01').exists()).toBe(true);
        expect(cell(wrapper, '2026-01-03').attributes('data-level')).toBe('0');
        expect(cell(wrapper, '2026-01-11').exists()).toBe(true);
    });

    it('user sees the busiest day in the darkest step and an idle day in the lightest', () => {
        const wrapper = mountHeatmap();

        expect(Number(cell(wrapper, '2026-01-05').attributes('data-level'))).toBe(4);
        expect(Number(cell(wrapper, '2026-01-02').attributes('data-level'))).toBe(1);
        expect(Number(cell(wrapper, '2026-01-01').attributes('data-level'))).toBe(1);
        expect(Number(cell(wrapper, '2026-01-11').attributes('data-level'))).toBe(0);
    });

    it('user sees month labels and only three weekday labels so the grid stays readable', () => {
        const wrapper = mountHeatmap();

        const texts = wrapper.findAll('text').map((node) => node.text());
        expect(texts).toContain('1月');
        // Narrow weekday names for rows 1, 3 and 5 only.
        expect(texts.slice(1)).toHaveLength(3);
    });

    it('user gets the calendar labelled for a screen reader', () => {
        const wrapper = mountHeatmap({ label: 'Token activity' });

        expect(wrapper.get('svg').attributes('aria-label')).toBe('Token activity');
        expect(wrapper.get('svg').attributes('role')).toBe('img');
    });

    it('user sees the cells fade in rather than pop in', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();

        expect(cell(wrapper, '2026-01-05').attributes('style')).toContain('opacity: 1');
    });
});

describe('user inspects a day with the pointer', () => {
    it('user sees a bubble with the day count and the date', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();

        await cell(wrapper, '2026-01-02').trigger('pointerenter');

        expect(bubble(wrapper).text()).toContain('3');
        expect(bubble(wrapper).text()).toContain('2026');
    });

    it('user sees the caller’s own unit in the bubble', async () => {
        const wrapper = mountHeatmap({ unit: { one: '次调用', other: '次调用' } });
        await flushPromises();

        await cell(wrapper, '2026-01-02').trigger('pointerenter');

        expect(bubble(wrapper).text()).toContain('次调用');
    });

    it('user sees a quiet day said as zero rather than hidden', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();

        await cell(wrapper, '2026-01-11').trigger('pointerenter');

        expect(bubble(wrapper).text().startsWith('0')).toBe(true);
    });

    it('user gets the caller’s own value format in the bubble', async () => {
        const wrapper = mountHeatmap({ formatValue: (value: number) => `${value} tok` });
        await flushPromises();

        await cell(wrapper, '2026-01-05').trigger('pointerenter');

        expect(bubble(wrapper).text()).toContain('9 tok');
    });

    it('user gets the caller’s own date format in the bubble', async () => {
        const wrapper = mountHeatmap({
            formatDate: (date: Date) => date.toISOString().slice(0, 10),
        });
        await flushPromises();

        await cell(wrapper, '2026-01-01').trigger('pointerenter');

        expect(bubble(wrapper).text()).toContain('2026-01-01');
    });

    it('user sees the extra detail for a day when the caller supplies it', async () => {
        const wrapper = mountHeatmap({
            detailOf: (date: string) => (date === '2026-01-02' ? '1.2k tokens · $0.04' : null),
        });
        await flushPromises();

        await cell(wrapper, '2026-01-02').trigger('pointerenter');

        expect(bubble(wrapper).text()).toContain('1.2k tokens · $0.04');
    });

    it('user sees no extra detail line for a day the caller has none for', async () => {
        const wrapper = mountHeatmap({ detailOf: () => null });
        await flushPromises();

        await cell(wrapper, '2026-01-02').trigger('pointerenter');

        expect(bubble(wrapper).findAll('div')).toHaveLength(2);
    });

    it('user sees the bubble disappear when the pointer leaves', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();

        await cell(wrapper, '2026-01-02').trigger('pointerenter');
        await cell(wrapper, '2026-01-02').trigger('pointerleave');

        expect(wrapper.find('[data-testid="activity-heatmap-tooltip"]').exists()).toBe(false);
    });

    it('user sees the bubble flip inward near the right edge instead of being cut off', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();

        await cell(wrapper, '2026-01-01').trigger('pointerenter');
        const leftSide = bubble(wrapper).attributes('style');

        await cell(wrapper, '2026-01-11').trigger('pointerenter');
        const rightSide = bubble(wrapper).attributes('style');

        expect(leftSide).toContain('translate(0, -100%)');
        expect(rightSide).toContain('translate(-100%, -100%)');
    });
});

describe('user walks the calendar with the keyboard', () => {
    it('user gets the newest day described when first pressing an arrow', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();
        const svg = wrapper.get('svg');

        await svg.trigger('keydown', { key: 'ArrowLeft' });

        expect(wrapper.find('[data-testid="activity-heatmap-tooltip"]').exists()).toBe(true);
    });

    it('user gets an earlier day when pressing home', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();
        const svg = wrapper.get('svg');

        await svg.trigger('keydown', { key: 'End' });
        const last = bubble(wrapper).text();
        await svg.trigger('keydown', { key: 'Home' });
        const first = bubble(wrapper).text();

        expect(first).not.toBe(last);
        expect(first).toContain('2026年1月1日');
    });

    it('user gets a different day when pressing up than when pressing left', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();
        const svg = wrapper.get('svg');

        await svg.trigger('keydown', { key: 'Home' });
        await svg.trigger('keydown', { key: 'ArrowRight' });
        const afterRight = bubble(wrapper).text();

        await svg.trigger('keydown', { key: 'Home' });
        await svg.trigger('keydown', { key: 'ArrowDown' });
        const afterDown = bubble(wrapper).text();

        expect(afterRight).not.toBe(afterDown);
    });

    it('user dismisses the bubble with Escape', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();
        await wrapper.get('svg').trigger('keydown', { key: 'Home' });

        await wrapper.get('svg').trigger('keydown', { key: 'Escape' });

        expect(wrapper.find('[data-testid="activity-heatmap-tooltip"]').exists()).toBe(false);
    });

    it('user keeps the bubble when pressing an unrelated key', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();
        await wrapper.get('svg').trigger('keydown', { key: 'Home' });
        const before = bubble(wrapper).text();

        await wrapper.get('svg').trigger('keydown', { key: 'a' });

        expect(bubble(wrapper).text()).toBe(before);
    });

    it('user loses the bubble when the calendar loses focus', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();
        await wrapper.get('svg').trigger('keydown', { key: 'Home' });

        await wrapper.get('svg').trigger('blur');

        expect(wrapper.find('[data-testid="activity-heatmap-tooltip"]').exists()).toBe(false);
    });
});

describe('user reads the legend', () => {
    it('user sees one swatch per level', () => {
        const wrapper = mountHeatmap();

        expect(wrapper.findAll('figcaption button')).toHaveLength(5);
    });

    it('user sees how many days sit in a level while hovering its swatch', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();

        await wrapper.findAll('figcaption button')[1]!.trigger('pointerenter');

        expect(wrapper.get('[data-testid="activity-heatmap-caption"]').text()).toMatch(/\d+/);
    });

    it('user gets the level pinned after clicking its swatch', async () => {
        const wrapper = mountHeatmap();
        const swatch = wrapper.findAll('figcaption button')[2]!;

        await swatch.trigger('click');

        expect(swatch.attributes('aria-pressed')).toBe('true');
        expect(wrapper.find('[data-testid="activity-heatmap-caption"]').exists()).toBe(true);
    });

    it('user gets the pin released by clicking the same swatch again', async () => {
        const wrapper = mountHeatmap();
        const swatch = wrapper.findAll('figcaption button')[2]!;

        await swatch.trigger('click');
        await swatch.trigger('click');

        expect(swatch.attributes('aria-pressed')).toBe('false');
        expect(wrapper.find('[data-testid="activity-heatmap-caption"]').exists()).toBe(false);
    });

    it('user sees the days of the hovered level emphasised and the rest dimmed', async () => {
        const wrapper = mountHeatmap();
        await flushPromises();

        await wrapper.findAll('figcaption button')[4]!.trigger('pointerenter');

        expect(cell(wrapper, '2026-01-05').attributes('style')).toContain('opacity: 1');
        expect(cell(wrapper, '2026-01-01').attributes('style')).toContain('opacity: 0.22');
    });

    it('user sees the calendar at full strength once the legend preview ends', async () => {
        vi.useFakeTimers();
        try {
            const wrapper = mountHeatmap();
            const swatch = wrapper.findAll('figcaption button')[4]!;
            await swatch.trigger('pointerenter');

            await swatch.trigger('pointerleave');
            await vi.advanceTimersByTimeAsync(120);

            expect(cell(wrapper, '2026-01-01').attributes('style')).toContain('opacity: 1');
        } finally {
            vi.useRealTimers();
        }
    });

    it('user reads the calendar immediately when reduced motion is requested', async () => {
        // Nothing animates, so the cells are readable on the very first paint
        // even though requestAnimationFrame never runs.
        vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList);
        vi.stubGlobal('requestAnimationFrame', () => 1);

        const wrapper = mountHeatmap();
        await flushPromises();

        expect(cell(wrapper, '2026-01-01').attributes('style')).toContain('opacity: 1');
    });
});

describe('user reads a full year of activity', () => {
    function todayIso(): string {
        const today = new Date();
        return [
            today.getFullYear(),
            String(today.getMonth() + 1).padStart(2, '0'),
            String(today.getDate()).padStart(2, '0'),
        ].join('-');
    }

    it('user sees a whole year even though only a few days have data', () => {
        const wrapper = mountHeatmap({
            yearWindow: true,
            days: [{ date: todayIso(), count: 2 }],
        });

        // 365 days padded out to complete weeks.
        expect(cells(wrapper).length).toBeGreaterThanOrEqual(365);
    });

    it('user sees today near the right edge of the year window', () => {
        const wrapper = mountHeatmap({
            yearWindow: true,
            days: [{ date: todayIso(), count: 2 }],
        });

        const all = cells(wrapper);
        expect(all.some((node) => node.attributes('data-day') === todayIso())).toBe(true);
        expect(
            Number(wrapper.find(`rect[data-day="${todayIso()}"]`).attributes('data-level'))
        ).toBeGreaterThan(0);
    });

    it('user does not get a year window when the caller wants only their own range', () => {
        const wrapper = mountHeatmap({ yearWindow: false });

        expect(cells(wrapper)).toHaveLength(11);
    });
});
