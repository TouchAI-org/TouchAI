// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { UsageRankItem } from '@database/queries/usageStats';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import UsageRanking from '@/views/SettingsView/components/Usage/components/UsageRanking.vue';

function item(overrides: Partial<UsageRankItem> = {}): UsageRankItem {
    return {
        id: 1,
        name: 'gpt-5',
        subtitle: null,
        lastAt: null,
        requests: 10,
        tokens: 12_000,
        costMicros: 1_000_000,
        unpricedCount: 0,
        durationMs: 60_000,
        ...overrides,
    };
}

const items = [
    item({ id: 1, name: 'gpt-5', tokens: 12_000 }),
    item({ id: 2, name: 'claude', tokens: 6_000 }),
];

function mountRanking(overrides: Record<string, unknown> = {}) {
    return mount(UsageRanking, {
        props: {
            title: '模型排行',
            items,
            metric: 'tokens',
            ...overrides,
        },
    });
}

beforeEach(() => setLocale('zh-CN'));

describe('user reviews a usage ranking', () => {
    it('user sees every ranked name with its value', () => {
        const wrapper = mountRanking();

        const rows = wrapper.findAll('[data-testid="settings-usage-ranking-row"]');
        expect(rows).toHaveLength(2);
        expect(rows[0]!.text()).toContain('gpt-5');
        expect(rows[0]!.text()).toContain('1.2万');
        expect(rows[1]!.text()).toContain('claude');
    });

    it('user only gets a duration switch for sessions, which have a duration', () => {
        const modelRanking = mountRanking();
        const sessionRanking = mountRanking({ title: '会话排行', supportsDuration: true });

        expect(modelRanking.text()).not.toContain('活跃');
        expect(sessionRanking.text()).toContain('活跃');
    });

    it('user asks the parent to switch the ranking metric', async () => {
        const wrapper = mountRanking();
        const cost = wrapper.findAll('button').find((button) => button.text() === '费用')!;

        await cost.trigger('click');

        expect(wrapper.emitted('update:metric')).toEqual([['cost']]);
    });

    it('user filters the page by clicking a row', async () => {
        const wrapper = mountRanking();

        await wrapper.findAll('[data-testid="settings-usage-ranking-row"]')[1]!.trigger('click');

        expect(wrapper.emitted('select')).toEqual([[2]]);
    });

    it('user clears the filter by clicking the selected row again', async () => {
        const wrapper = mountRanking({ selectedId: 2 });

        await wrapper.findAll('[data-testid="settings-usage-ranking-row"]')[1]!.trigger('click');

        expect(wrapper.emitted('select')).toEqual([[null]]);
    });

    it('user sees which row is currently filtering the page', () => {
        const wrapper = mountRanking({ selectedId: 2 });
        const rows = wrapper.findAll('[data-testid="settings-usage-ranking-row"]');

        expect(rows[1]!.attributes('aria-pressed')).toBe('true');
        expect(rows[0]!.attributes('aria-pressed')).toBe('false');
    });

    it('user sees the leader bar full and the runner-up shorter', () => {
        const wrapper = mountRanking();
        const bars = wrapper.findAll('[data-testid="settings-usage-ranking-row"] > div > div');

        expect(bars[0]!.attributes('style')).toContain('width: 100%');
        expect(bars[1]!.attributes('style')).toContain('width: 50%');
    });

    it('user sees an estimated cost marked with a lower bound when some turns were unpriced', () => {
        const wrapper = mountRanking({
            metric: 'cost',
            items: [item({ costMicros: 2_500_000, unpricedCount: 3 })],
        });

        expect(wrapper.text()).toContain('≥');
    });

    it('user sees placeholder rows so both rankings keep the same height', () => {
        const wrapper = mountRanking({ heightRows: 4 });

        expect(wrapper.findAll('[data-testid="settings-usage-ranking-row"]')).toHaveLength(2);
        expect(wrapper.findAll('[data-testid="settings-usage-ranking-placeholder"]')).toHaveLength(
            2
        );
    });

    it('user is told the ranking is empty instead of seeing an empty box', () => {
        const wrapper = mountRanking({ items: [] });

        expect(wrapper.text()).toContain('暂无数据');
    });

    it('user sees a skeleton instead of an empty state while the ranking is loading', () => {
        const wrapper = mountRanking({ items: [], loading: true });

        expect(wrapper.text()).not.toContain('暂无数据');
        expect(wrapper.html()).toContain('animate-pulse');
    });

    it('user sees the session subtitle and last-active time together', () => {
        const wrapper = mountRanking({
            title: '会话排行',
            supportsDuration: true,
            metric: 'duration',
            items: [
                item({
                    name: 'Fixing the build',
                    subtitle: 'gpt-5',
                    lastAt: '2026-05-01 10:00:00',
                    durationMs: 90_000,
                }),
            ],
        });

        const row = wrapper.get('[data-testid="settings-usage-ranking-row"]');
        expect(row.attributes('title')).toContain('gpt-5');
        expect(row.text()).toContain('90.0s');
    });
});
