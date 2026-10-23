// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { UsageLiveTurn, UsageSummary, UsageTrendPoint } from '@database/queries/usageStats';
import type { SessionTaskUsageProgressEvent } from '@services/EventService';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import UsageDashboard from '@/views/SettingsView/components/Usage/components/UsageDashboard.vue';

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
        global: { stubs: { AppIcon: true } },
    });
}

beforeEach(() => {
    setLocale('zh-CN');
    listeners.clear();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('user watches the usage curve', () => {
    it('user sees the curve drawn from the history with the mean speed while idle', async () => {
        const wrapper = mountDashboard();
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-usage-dashboard"] svg path').exists()).toBe(
            true
        );
        expect(wrapper.text()).toContain('12.5');
        expect(wrapper.text()).toContain('平均速度');
        expect(wrapper.text()).toContain('2 个会话');
        wrapper.unmount();
    });

    it('user sees a flat line instead of a blank plot when the range has no points', async () => {
        const wrapper = mountDashboard({ trend: [] });
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-usage-dashboard"] svg').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user reads a point value by moving the pointer over the curve', async () => {
        const wrapper = mountDashboard();
        await flushPromises();
        const svg = wrapper.get('[data-testid="settings-usage-dashboard"] svg');

        Object.defineProperty(svg.element, 'getBoundingClientRect', {
            value: () => ({ left: 0, width: 400, top: 0, height: 96 }),
        });
        svg.element.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, bubbles: true }));
        await flushPromises();

        const tooltip = wrapper.get('[data-testid="usage-curve-tooltip"]');
        expect(tooltip.text()).toContain('tok/s');
        wrapper.unmount();
    });

    it('user steps through the curve with the arrow keys and dismisses the readout with Escape', async () => {
        const wrapper = mountDashboard();
        await flushPromises();
        const svg = wrapper.get('[data-testid="settings-usage-dashboard"] svg');

        await svg.trigger('keydown', { key: 'ArrowLeft' });
        expect(wrapper.find('[data-testid="usage-curve-tooltip"]').exists()).toBe(true);

        await svg.trigger('keydown', { key: 'Escape' });
        expect(wrapper.find('[data-testid="usage-curve-tooltip"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user sees the live speed and the live window while a turn streams', async () => {
        vi.useFakeTimers();
        try {
            const wrapper = mountDashboard();
            await flushPromises();

            listeners.get('session:task:usage-progress')?.(progressEvent());
            await flushPromises();
            await vi.advanceTimersByTimeAsync(400);

            expect(wrapper.text()).toContain('实时速度');
            expect(wrapper.text()).toContain('最近 15 秒');
            expect(wrapper.text()).toContain('40.0');
            expect(wrapper.text()).toContain('1 个会话');
            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('user is told which task to keep refreshing while a turn streams', async () => {
        const wrapper = mountDashboard();
        await flushPromises();

        listeners.get('session:task:usage-progress')?.(progressEvent({ streaming: false }));
        await flushPromises();

        expect(wrapper.emitted('track-tasks')).toEqual([[['task-1']]]);
        wrapper.unmount();
    });

    it('user sees an estimated total when some turns were never priced', async () => {
        const wrapper = mountDashboard({
            summary: { ...summary, unpricedCount: 2, totalCostMicros: 3_000_000 },
        });
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-usage-card-cost"]').text()).toContain('≥');
        expect(wrapper.get('[data-testid="settings-usage-card-cost"]').text()).toContain(
            '2 次调用未定价'
        );
        wrapper.unmount();
    });

    it('user sees a reasoning row only when reasoning tokens were used', async () => {
        const withReasoning = mountDashboard();
        await flushPromises();
        expect(withReasoning.find('[data-testid="settings-usage-metric-reasoning"]').exists()).toBe(
            true
        );
        withReasoning.unmount();

        const withoutReasoning = mountDashboard({ summary: { ...summary, reasoningTokens: 0 } });
        await flushPromises();
        expect(
            withoutReasoning.find('[data-testid="settings-usage-metric-reasoning"]').exists()
        ).toBe(false);
        withoutReasoning.unmount();
    });

    it('user sees the failure rate of the period, not a perfect score', async () => {
        const wrapper = mountDashboard();
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-usage-card-requests"]').text()).toContain(
            '83.0%'
        );
        wrapper.unmount();
    });

    it('user sees a dash instead of a speed when nothing was measured', async () => {
        const wrapper = mountDashboard({ summary: { ...summary, decodeSpeed: null } });
        await flushPromises();

        expect(wrapper.text()).toContain('—');
        wrapper.unmount();
    });

    it('user sees zeros instead of stale values before the first load finishes', async () => {
        const wrapper = mountDashboard({ summary: null });
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-usage-card-cost"]').text()).toContain('0.00');
        expect(wrapper.get('[data-testid="settings-usage-card-requests"]').text()).toContain('0');
        expect(wrapper.find('[data-testid="settings-usage-metric-rpm"]').exists()).toBe(false);
        wrapper.unmount();
    });
});
