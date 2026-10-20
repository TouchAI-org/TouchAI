// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageSummary } from '@database/queries/usageStats';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import UsageDashboard from '@/views/SettingsView/components/Usage/components/UsageDashboard.vue';

vi.mock('@services/EventService', () => ({
    AppEvent: { SESSION_TASK_USAGE_PROGRESS: 'session:task:usage-progress' },
    eventService: { on: vi.fn(async () => () => undefined) },
}));

const summary: UsageSummary = {
    requestCount: 6,
    sessionCount: 2,
    activeDayCount: 7,
    totalDurationMs: (188 * 60 + 7) * 60_000,
    firstRequestAt: '2026-05-01 00:00:00',
    successCount: 6,
    totalCostMicros: 1_500_000,
    unpricedCount: 0,
    inputTokens: 600,
    outputTokens: 100,
    cacheReadTokens: 9400,
    cacheWriteTokens: 0,
    reasoningTokens: 50,
    realTotalTokens: 10_100,
    cacheHitRate: 0.94,
    successRate: 1,
    meanTtftMs: 850,
    meanDurationMs: 1000,
    decodeSpeed: 10,
};

const wrappers: ReturnType<typeof mount>[] = [];

function mountDashboard(value: UsageSummary = summary) {
    const wrapper = mount(UsageDashboard, {
        props: {
            summary: value,
            trend: [],
            bucket: 'day',
            liveTurns: [],
            range: { preset: '7d', from: '2026-05-01 00:00:00', to: '2026-05-08 00:00:00' },
        },
        global: { stubs: { AppIcon: true } },
    });
    wrappers.push(wrapper);
    return wrapper;
}

beforeEach(() => setLocale('zh-CN'));
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));

describe('usage dashboard paired metrics', () => {
    it('pairs cache read with hit rate and active duration with distinct active days', async () => {
        const wrapper = mountDashboard();
        await flushPromises();

        expect(wrapper.findAll('[data-testid^="settings-usage-card-"]')).toHaveLength(6);
        const cache = wrapper.get('[data-testid="settings-usage-card-cacheRead"]');
        expect(cache.text()).toContain('缓存读取');
        // 中文用「万」作单位；9400 不足一万，直接给原数
        expect(cache.text()).toContain('9400');
        expect(cache.text()).toContain('命中率 94.0%');

        const activity = wrapper.get('[data-testid="settings-usage-card-activity"]');
        expect(activity.text()).toContain('活跃时长');
        expect(activity.text()).toMatch(/188\s*小时\s*7\s*分/);
        expect(activity.text()).toContain('共 7 天');
        expect(activity.attributes('title')).toContain('耗时之和');

        const ttft = wrapper.get('[data-testid="settings-usage-metric-ttft"]');
        expect(ttft.text()).toContain('平均首字');
        expect(ttft.text()).toContain('850ms');
        expect(wrapper.find('[data-testid="settings-usage-metric-cacheRead"]').exists()).toBe(
            false
        );
        expect(wrapper.find('[data-testid="settings-usage-metric-cacheRate"]').exists()).toBe(
            false
        );
    });

    it('updates the paired values when the filtered summary changes', async () => {
        const wrapper = mountDashboard();
        await wrapper.setProps({
            summary: {
                ...summary,
                activeDayCount: 1,
                totalDurationMs: 3000,
                cacheReadTokens: 0,
                cacheHitRate: 0,
            },
        });

        expect(wrapper.get('[data-testid="settings-usage-card-activity"]').text()).toMatch(
            /3\s*秒/
        );
        expect(wrapper.get('[data-testid="settings-usage-card-activity"]').text()).toContain(
            '共 1 天'
        );
        expect(wrapper.get('[data-testid="settings-usage-card-cacheRead"]').text()).toContain(
            '命中率 0.0%'
        );
    });

    it('derives mean RPM from active minutes so it stays informative', async () => {
        const wrapper = mountDashboard({
            ...summary,
            requestCount: 60,
            totalDurationMs: 600_000,
        });
        await flushPromises();

        // 60 次请求 / 10 分钟活跃 = 6.0 RPM；用日历跨度算只会得到接近 0 的数字
        expect(wrapper.get('[data-testid="settings-usage-metric-rpm"]').text()).toContain('6.0');

        await wrapper.setProps({ summary: { ...summary, requestCount: 0 } });
        expect(wrapper.get('[data-testid="settings-usage-metric-rpm"]').text()).toContain('—');

        await wrapper.setProps({ summary: { ...summary, totalDurationMs: 0 } });
        expect(wrapper.get('[data-testid="settings-usage-metric-rpm"]').text()).toContain('—');
    });

    it('localizes the units and supporting labels together', async () => {
        setLocale('en-US');
        const wrapper = mountDashboard();
        await flushPromises();

        const cache = wrapper.get('[data-testid="settings-usage-card-cacheRead"]');
        expect(cache.text()).toContain('Cache read');
        expect(cache.text()).toContain('Hit rate 94.0%');
        const activity = wrapper.get('[data-testid="settings-usage-card-activity"]');
        expect(activity.text()).toContain('Active time');
        expect(activity.text()).toMatch(/188\s*h\s*7\s*m/);
        expect(activity.text()).toContain('7 active days');
        await wrapper.setProps({ summary: { ...summary, activeDayCount: 1 } });
        expect(activity.text()).toContain('1 active day');
        expect(activity.text()).not.toContain('1 active days');
    });
});
