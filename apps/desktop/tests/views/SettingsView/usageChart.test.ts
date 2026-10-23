// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { UsageTrendPoint } from '@database/queries/usageStats';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import UsageChart from '@/views/SettingsView/components/Usage/components/UsageChart.vue';

function point(key: string, segments: Array<[string, number, number, number]>): UsageTrendPoint {
    return {
        key,
        requests: segments.reduce((sum, [, requests]) => sum + requests, 0),
        tokens: segments.reduce((sum, [, , tokens]) => sum + tokens, 0),
        costMicros: segments.reduce((sum, [, , , cost]) => sum + cost, 0),
        segments: segments.map(([name, requests, tokens, costMicros]) => ({
            groupId: null,
            name,
            requests,
            tokens,
            costMicros,
        })),
    };
}

const trend: UsageTrendPoint[] = [
    point('2026-05-01', [
        ['gpt-5', 10, 5000, 1_000_000],
        ['claude', 2, 1000, 200_000],
    ]),
    point('2026-05-02', [
        ['gpt-5', 6, 3000, 600_000],
        ['claude', 4, 2000, 400_000],
    ]),
];

function mountChart(overrides: Record<string, unknown> = {}) {
    return mount(UsageChart, {
        props: {
            points: trend,
            bucket: 'day',
            bucketMs: 86_400_000,
            dimension: 'model',
            ...overrides,
        },
    });
}

beforeEach(() => setLocale('zh-CN'));

describe('user reviews the usage trend', () => {
    it('user sees the trend card with the model/provider switch and the metric switch', () => {
        const wrapper = mountChart();

        expect(wrapper.text()).toContain('使用趋势与分布');
        expect(wrapper.text()).toContain('按模型');
        expect(wrapper.text()).toContain('按供应商');
        expect(wrapper.text()).toContain('Tokens');
        expect(wrapper.text()).toContain('成本');
    });

    it('user sees the active dimension and metric marked as pressed', () => {
        const wrapper = mountChart({ dimension: 'provider' });
        const pressed = wrapper
            .findAll('button[aria-pressed="true"]')
            .map((button) => button.text());

        expect(pressed).toEqual(expect.arrayContaining(['按供应商', 'Tokens']));
        expect(pressed).not.toContain('按模型');
    });

    it('user asks the parent to switch the breakdown dimension when clicking it', async () => {
        const wrapper = mountChart();
        const provider = wrapper.findAll('button').find((button) => button.text() === '按供应商')!;

        await provider.trigger('click');

        expect(wrapper.emitted('update:dimension')).toEqual([['provider']]);
    });

    it('user switches the plotted metric without telling the parent', async () => {
        const wrapper = mountChart();
        const cost = wrapper.findAll('button').find((button) => button.text() === '成本')!;

        await cost.trigger('click');

        expect(cost.attributes('aria-pressed')).toBe('true');
        expect(wrapper.emitted('update:dimension')).toBeUndefined();
    });

    it('user sees the remaining models folded into "other" when more than five compete', () => {
        const many: UsageTrendPoint[] = [
            point('2026-05-01', [
                ['m1', 1, 600, 0],
                ['m2', 1, 500, 0],
                ['m3', 1, 400, 0],
                ['m4', 1, 300, 0],
                ['m5', 1, 200, 0],
                ['m6', 1, 100, 0],
            ]),
        ];

        const wrapper = mountChart({ points: many });

        expect(wrapper.text()).toContain('其他');
    });

    it('user sees no "other" entry when every model fits', () => {
        const wrapper = mountChart();

        expect(wrapper.text()).not.toContain('其他');
    });

    it('user sees an empty-state message instead of a broken plot when the range has no data', () => {
        const wrapper = mountChart({ points: [] });

        expect(wrapper.text()).toContain('这段时间没有用量');
    });

    it('user sees the English labels, including the folded group, when the app is in English', () => {
        setLocale('en-US');

        const wrapper = mountChart({
            points: [
                point('2026-05-01', [
                    ['m1', 1, 600, 0],
                    ['m2', 1, 500, 0],
                    ['m3', 1, 400, 0],
                    ['m4', 1, 300, 0],
                    ['m5', 1, 200, 0],
                    ['m6', 1, 100, 0],
                ]),
            ],
        });

        expect(wrapper.text()).toContain('Trend and breakdown');
        expect(wrapper.text()).toContain('By model');
        expect(wrapper.text()).toContain('Other');
    });
});
