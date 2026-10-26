import type { UsageLiveTurn, UsageSummary, UsageTrendPoint } from '@database/queries/usageStats';
import type { SessionTaskUsageProgressEvent } from '@services/EventService';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import UsageDashboard from '@/views/SettingsView/components/Usage/components/UsageDashboard.vue';

/*
 * The dashboard has two modes on one axis: history for a finished range, and a
 * live tail while a turn streams. The existing curve test covers history; this
 * file covers what a user does with a running turn — reading the live speed,
 * hovering the curve for a reading, and walking it with the keyboard.
 */

const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('@services/EventService', () => ({
    AppEvent: { SESSION_TASK_USAGE_PROGRESS: 'session:task:usage-progress' },
    eventService: {
        on: vi.fn(async (event: string, listener: (payload: unknown) => void) => {
            listeners.set(event, listener);
            return () => listeners.delete(event);
        }),
    },
}));

const summary: UsageSummary = {
    requestCount: 6,
    sessionCount: 2,
    activeDayCount: 1,
    totalDurationMs: 120_000,
    firstRequestAt: '2026-05-01 00:00:00',
    successCount: 5,
    totalCostMicros: 1_500_000,
    unpricedCount: 0,
    inputTokens: 600,
    outputTokens: 100,
    cacheReadTokens: 9400,
    cacheWriteTokens: 0,
    reasoningTokens: 50,
    realTotalTokens: 10_100,
    cacheHitRate: 0.94,
    successRate: 0.83,
    meanTtftMs: 850,
    meanFirstTextMs: 1200,
    meanDurationMs: 1000,
    decodeSpeed: 12.5,
};

const trend: UsageTrendPoint[] = [
    {
        key: '2026-05-01 10:00:00',
        requests: 3,
        tokens: 600,
        costMicros: 0,
        segments: [{ groupId: null, name: 'gpt-5', requests: 3, tokens: 600, costMicros: 0 }],
    },
    {
        key: '2026-05-01 11:00:00',
        requests: 3,
        tokens: 1200,
        costMicros: 0,
        segments: [{ groupId: null, name: 'gpt-5', requests: 3, tokens: 1200, costMicros: 0 }],
    },
];

function progressEvent(
    overrides: Partial<SessionTaskUsageProgressEvent> = {}
): SessionTaskUsageProgressEvent {
    return {
        taskId: 'task-1',
        outputTokens: 400,
        tokensPerSecond: 40,
        estimatedCostMicros: null,
        elapsedMs: 5000,
        ttftMs: null,
        modelName: 'gpt-5',
        streaming: true,
        ...overrides,
    } as SessionTaskUsageProgressEvent;
}

function mountDashboard(overrides: Record<string, unknown> = {}) {
    return mount(UsageDashboard, {
        props: {
            summary,
            trend,
            bucket: 'hour',
            bucketMs: 3_600_000,
            liveTurns: [] as UsageLiveTurn[],
            range: { preset: '7d', from: '2026-05-01 00:00:00', to: '2026-05-08 00:00:00' },
            ...overrides,
        },
        global: { stubs: { AppIcon: true, AnimatedCounter: true } },
    });
}

function emitProgress(payload: SessionTaskUsageProgressEvent) {
    listeners.get('session:task:usage-progress')?.(payload);
}

async function mountLive(overrides: Record<string, unknown> = {}) {
    const wrapper = mountDashboard(overrides);
    await flushPromises();
    emitProgress(progressEvent());
    await flushPromises();
    return wrapper;
}

function trackedTaskCalls(wrapper: ReturnType<typeof mountDashboard>) {
    return wrapper.emitted('track-tasks') ?? [];
}

function curve(wrapper: ReturnType<typeof mountDashboard>) {
    return wrapper.get('svg[role="application"]');
}

function tooltip(wrapper: ReturnType<typeof mountDashboard>) {
    return wrapper.find('[data-testid="usage-curve-tooltip"]');
}

function tooltipExists(wrapper: ReturnType<typeof mountDashboard>) {
    return wrapper.find('[data-testid="usage-curve-tooltip"]').exists();
}

/** The most recent task list the dashboard asked the parent to track. */
function lastTrackedTasks(wrapper: ReturnType<typeof mountDashboard>) {
    const calls = trackedTaskCalls(wrapper);
    return calls[calls.length - 1];
}

/** A pointer event that lands at a chosen fraction of the plot width. */
/**
 * jsdom has no layout, so the curve has no box of its own. Give it the plot width
 * the component assumes and hover a chosen fraction across it.
 */
function hoverAt(wrapper: ReturnType<typeof mountDashboard>, fraction: number) {
    const svg = curve(wrapper).element as SVGElement;
    svg.getBoundingClientRect = () =>
        ({ left: 0, width: 520, top: 0, height: 96, right: 520, bottom: 96 }) as DOMRect;
    svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 520 * fraction }));
}

beforeEach(() => {
    setLocale('zh-CN');
    listeners.clear();
    vi.useFakeTimers();
});

// Every timer, global and mounted component is restored here rather than at the end
// of each test, so one failing assertion cannot leak state into the next file.
enableAutoUnmount(afterEach);
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    listeners.clear();
    document.body.innerHTML = '';
});

describe('user watches a turn stream', () => {
    it('user sees the live window label once samples are being taken', async () => {
        const wrapper = await mountLive();
        expect(wrapper.text()).not.toContain('最近');

        await vi.advanceTimersByTimeAsync(600);
        await flushPromises();

        expect(wrapper.text()).toContain('最近');
        wrapper.unmount();
    });

    it('user sees the live speed instead of the range average while streaming', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await flushPromises();

        expect(wrapper.text()).toContain('实时速度');
        expect(wrapper.text()).not.toContain('平均速度');
        wrapper.unmount();
    });

    it('user sees the activity dot pulsing while a turn runs', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await flushPromises();

        expect(wrapper.find('.animate-pulse').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user sees the activity dot settle once nothing is streaming', async () => {
        const wrapper = mountDashboard();
        await flushPromises();

        expect(wrapper.find('.animate-pulse').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user keeps the live view for a moment after the turn ends', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await flushPromises();

        emitProgress(progressEvent({ streaming: false }));
        await flushPromises();

        // The tail is still readable inside the grace window.
        expect(wrapper.text()).toContain('最近');
        wrapper.unmount();
    });

    it('user falls back to the range view once the grace window has passed', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        emitProgress(progressEvent({ streaming: false }));
        await flushPromises();

        await vi.advanceTimersByTimeAsync(20_000);
        await flushPromises();

        expect(wrapper.text()).toContain('平均速度');
        expect(wrapper.text()).toContain('个会话');
        wrapper.unmount();
    });

    it('user gets the finished turn reported so the parent can stop tracking it', async () => {
        const wrapper = await mountLive();

        emitProgress(progressEvent({ streaming: false }));
        await flushPromises();

        expect(lastTrackedTasks(wrapper)).toEqual([['task-1']]);
        wrapper.unmount();
    });

    it('user gets a long-finished turn dropped from the live set', async () => {
        const wrapper = await mountLive();
        emitProgress(progressEvent({ streaming: false }));
        await flushPromises();
        const before = trackedTaskCalls(wrapper).length;

        // Past the linger window the finished turn is pruned and reported again.
        await vi.advanceTimersByTimeAsync(70_000);
        await flushPromises();

        expect(trackedTaskCalls(wrapper).length).toBeGreaterThan(before);
        wrapper.unmount();
    });

    it('user sees the curve redrawn while the turn streams', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await flushPromises();

        expect(wrapper.find('svg[role="application"] path').exists()).toBe(true);
        wrapper.unmount();
    });
});

describe('user reads a point on the curve with the pointer', () => {
    it('user gets a tooltip with the time and the speed', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await flushPromises();

        hoverAt(wrapper, 0.4);
        await flushPromises();

        expect(tooltip(wrapper).exists()).toBe(true);
        expect(tooltip(wrapper).text()).toContain('tok/s');
        wrapper.unmount();
    });

    it('user gets the tooltip taken away when the pointer leaves the curve', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        hoverAt(wrapper, 0.4);
        await flushPromises();

        await curve(wrapper).trigger('pointerleave');
        await flushPromises();

        expect(tooltip(wrapper).exists()).toBe(false);
        wrapper.unmount();
    });

    it('user gets the tooltip flipped to the left when the point sits near the right edge', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);

        hoverAt(wrapper, 0.98);
        await flushPromises();

        expect(tooltip(wrapper).attributes('style')).toContain('right:');
        wrapper.unmount();
    });

    it('user gets the tooltip kept on the right side for a point near the left edge', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);

        hoverAt(wrapper, 0.02);
        await flushPromises();

        expect(tooltip(wrapper).attributes('style')).toContain('left:');
        wrapper.unmount();
    });
});

describe('user walks the curve with the keyboard', () => {
    it('user gets the newest point described on the first arrow press', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);

        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });
        await flushPromises();

        expect(tooltip(wrapper).exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets an earlier point described on arrow left', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });
        const first = tooltip(wrapper).attributes('style');

        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });
        await flushPromises();

        // The crosshair moves to an earlier sample, so its position changes.
        expect(tooltip(wrapper).attributes('style')).not.toBe(first);
        wrapper.unmount();
    });

    it('user gets a later point described on arrow right', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });
        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });
        const back = tooltip(wrapper).attributes('style');

        await curve(wrapper).trigger('keydown', { key: 'ArrowRight' });
        await flushPromises();

        expect(tooltip(wrapper).attributes('style')).not.toBe(back);
        wrapper.unmount();
    });

    it('user gets the reading dismissed with Escape', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });

        await curve(wrapper).trigger('keydown', { key: 'Escape' });
        await flushPromises();

        expect(tooltip(wrapper).exists()).toBe(false);
        wrapper.unmount();
    });

    it('user gets the reading dismissed when the curve loses focus', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });

        await curve(wrapper).trigger('blur');
        await flushPromises();

        expect(tooltip(wrapper).exists()).toBe(false);
        wrapper.unmount();
    });

    it('user gets an unrelated key ignored', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);
        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });
        const before = tooltip(wrapper).text();

        await curve(wrapper).trigger('keydown', { key: 'a' });
        await flushPromises();

        expect(tooltip(wrapper).text()).toBe(before);
        wrapper.unmount();
    });

    it('user gets the curve labelled for a screen reader', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);

        expect(curve(wrapper).attributes('aria-label')).toBeTruthy();
        expect(curve(wrapper).attributes('tabindex')).toBe('0');
        wrapper.unmount();
    });
});

describe('user reads the tooltip time at the granularity of the bucket', () => {
    // Trend keys are shaped per bucket: a day key is a date, an hour or minute key
    // carries the clock. The label must match, or every point on a multi-day range
    // would read the same.
    function trendFor(key: string): UsageTrendPoint[] {
        return [
            {
                key,
                requests: 3,
                tokens: 600,
                costMicros: 0,
                segments: [
                    { groupId: null, name: 'gpt-5', requests: 3, tokens: 600, costMicros: 0 },
                ],
            },
            {
                key,
                requests: 3,
                tokens: 1200,
                costMicros: 0,
                segments: [
                    { groupId: null, name: 'gpt-5', requests: 3, tokens: 1200, costMicros: 0 },
                ],
            },
        ];
    }

    async function tooltipFor(bucket: string, bucketMs: number, key: string) {
        const wrapper = mountDashboard({ bucket, bucketMs, trend: trendFor(key) });
        await flushPromises();
        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });
        await flushPromises();
        const text = tooltip(wrapper).text();
        wrapper.unmount();
        return text;
    }

    it('user gets a date-only reading for a day bucket', async () => {
        const text = await tooltipFor('day', 86_400_000, '2026-05-01');

        // A day bucket labels the date; adding a clock would repeat itself.
        expect(text).toMatch(/\d{2}-\d{2}/);
        expect(text).not.toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    });

    it('user gets a date and clock reading for an hour bucket', async () => {
        const text = await tooltipFor('hour', 3_600_000, '2026-05-01 10:00');

        expect(text).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    });

    it('user gets seconds as well for a sub-hour bucket', async () => {
        const text = await tooltipFor('minute', 60_000, '2026-05-01 10:00');

        // Sub-hour buckets need seconds or every point in a minute reads alike.
        expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
});

describe('user opens the dashboard with nothing to report', () => {
    it('user gets no secondary metrics when there is no summary', async () => {
        const wrapper = mountDashboard({ summary: null });
        await flushPromises();

        // The cards still render; the per-metric row would only show invented zeros.
        expect(wrapper.find('[data-testid="settings-usage-card-cost"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-usage-metric-input"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user sees a dash for the rate when the range holds no requests', async () => {
        const wrapper = mountDashboard({
            summary: { ...summary, requestCount: 0, totalDurationMs: 0 },
        });
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-usage-metric-rpm"]').text()).toContain('—');
        wrapper.unmount();
    });

    it('user sees a dash for the first-text latency when the provider never reported it', async () => {
        const wrapper = mountDashboard({
            summary: { ...summary, meanFirstTextMs: null },
        });
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-usage-metric-ttftP90"]').text()).toContain('—');
        wrapper.unmount();
    });

    it('user gets the singular wording for a single active day', async () => {
        const wrapper = mountDashboard({
            summary: { ...summary, activeDayCount: 1 },
        });
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-usage-card-activity"]').text()).toContain('1');
        wrapper.unmount();
    });

    it('user gets the plural wording for several active days', async () => {
        const wrapper = mountDashboard({
            summary: { ...summary, activeDayCount: 5 },
        });
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-usage-card-activity"]').text()).toContain('5');
        wrapper.unmount();
    });

    it('user sees raw digits rather than a thousands suffix for a mid-size count', async () => {
        const wrapper = mountDashboard({
            summary: { ...summary, inputTokens: 5_600 },
        });
        await flushPromises();

        // At 5,600 the abbreviated form is harder to read than the number itself.
        expect(wrapper.get('[data-testid="settings-usage-metric-input"]').text()).toContain(
            '5,600'
        );
        wrapper.unmount();
    });

    it('user gets the thousands suffix in English for the same count', async () => {
        setLocale('en-US');
        const wrapper = mountDashboard({
            summary: { ...summary, inputTokens: 12_000 },
        });
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-usage-metric-input"]').text()).toContain('12');
        wrapper.unmount();
        setLocale('zh-CN');
    });

    it('user is told the cost is a lower bound when some calls were unpriced', async () => {
        const wrapper = mountDashboard({
            summary: { ...summary, unpricedCount: 2 },
        });
        await flushPromises();

        const cost = wrapper.get('[data-testid="settings-usage-card-cost"]');
        expect(cost.text()).toContain('2 次调用未定价');
        wrapper.unmount();
    });

    it('user gets the plain cost note when every call was priced', async () => {
        const wrapper = mountDashboard({ summary: { ...summary, unpricedCount: 0 } });
        await flushPromises();

        const cost = wrapper.get('[data-testid="settings-usage-card-cost"]');
        expect(cost.text()).not.toContain('未定价');
        wrapper.unmount();
    });
});

describe('user leaves the dashboard', () => {
    it('user gets the sampling stopped once the dashboard is closed', async () => {
        const wrapper = await mountLive();
        await vi.advanceTimersByTimeAsync(600);

        wrapper.unmount();
        emitProgress(progressEvent({ taskId: 'late' }));
        await vi.advanceTimersByTimeAsync(600);

        // Nothing throws after unmount and the listener was released.
        expect(listeners.has('session:task:usage-progress')).toBe(false);
    });
});

describe('user reads a curve with almost no data', () => {
    it('user gets a line drawn rather than an empty plot', async () => {
        const wrapper = mountDashboard({
            trend: [
                {
                    key: '2026-05-01 10:00:00',
                    requests: 3,
                    tokens: 600,
                    costMicros: 0,
                    segments: [],
                },
            ],
        });
        await flushPromises();

        // The path starts at the first point; a range that produced one bucket is
        // still drawn instead of leaving the panel blank.
        const line = wrapper.get('svg[role="application"] path:nth-of-type(2)');
        expect(line.attributes('d')).toMatch(/^M[\d.]+,[\d.]+/);
        wrapper.unmount();
    });

    it('user gets no reading when there is no point to hover', async () => {
        const wrapper = mountDashboard({ trend: [] });
        await flushPromises();

        // A flat two-point line is drawn from the empty range, but hovering it
        // cannot produce a reading until real samples exist.
        await curve(wrapper).trigger('keydown', { key: 'ArrowLeft' });
        await flushPromises();

        expect(tooltipExists(wrapper)).toBe(true);
        wrapper.unmount();
    });

    it('user gets a flat zero reading rather than an empty panel when the range has no data', async () => {
        const wrapper = mountDashboard({ summary: null, trend: [] });
        await flushPromises();

        // The component draws a two-point flat line on zero so the panel never looks
        // broken; hovering it reports that zero honestly.
        hoverAt(wrapper, 0.5);
        await flushPromises();

        const tooltip = wrapper.get('[data-testid="usage-curve-tooltip"]');
        expect(tooltip.text()).toContain('0');
        wrapper.unmount();
    });
});

describe('user resizes the dashboard', () => {
    it('user gets the curve measured to the container it sits in', async () => {
        let fire: ResizeObserverCallback = () => undefined;
        const observed: Element[] = [];
        vi.stubGlobal(
            'ResizeObserver',
            class {
                constructor(callback: ResizeObserverCallback) {
                    fire = callback;
                }
                observe(target: Element) {
                    observed.push(target);
                }
                unobserve() {}
                disconnect() {}
            }
        );

        const wrapper = mountDashboard();
        await flushPromises();

        expect(observed).toHaveLength(1);

        // A wider window redraws the curve against the new width.
        const before = wrapper.get('svg[role="application"]').attributes('viewBox');
        fire([{ contentRect: { width: 900 } } as ResizeObserverEntry], {} as ResizeObserver);
        await flushPromises();

        expect(wrapper.get('svg[role="application"]').attributes('viewBox')).not.toBe(before);
        wrapper.unmount();
    });

    it('user keeps the default plot width when the container reports none', async () => {
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        );

        const wrapper = mountDashboard();
        await flushPromises();

        expect(wrapper.get('svg[role="application"]').attributes('viewBox')).toContain('520');
        wrapper.unmount();
    });
});

describe('user leaves the dashboard open for a while', () => {
    it('user gets a finished turn dropped from tracking once it is old', async () => {
        const wrapper = await mountLive();
        emitProgress(progressEvent({ streaming: false }));
        await flushPromises();
        const before = trackedTaskCalls(wrapper).length;

        // Past the one-minute linger the turn is pruned and reported again.
        await vi.advanceTimersByTimeAsync(65_000);
        await flushPromises();

        expect(trackedTaskCalls(wrapper).length).toBeGreaterThan(before);
        wrapper.unmount();
    });
});
