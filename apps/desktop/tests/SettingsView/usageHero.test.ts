// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageSummary } from '@database/queries/usageStats';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

import UsageHero from '../../src/views/SettingsView/components/Usage/components/UsageHero.vue';

function summary(partial: Partial<UsageSummary> = {}): UsageSummary {
    return {
        requestCount: 0,
        successCount: 0,
        totalCostMicros: 0,
        unpricedCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        realTotalTokens: 0,
        cacheHitRate: 0,
        successRate: 0,
        meanTtftMs: null,
        meanDurationMs: null,
        decodeSpeed: null,
        ...partial,
    };
}

function render(partial: Partial<UsageSummary> = {}, compact = false) {
    return mount(UsageHero, {
        props: { summary: summary(partial), compact, maskText: (value: string) => value },
    });
}

describe('UsageHero', () => {
    it('renders the four primary metric cards', () => {
        setLocale('zh-CN');
        const wrapper = render({ requestCount: 12, totalCostMicros: 1_500_000 });

        expect(wrapper.text()).toContain('总成本');
        expect(wrapper.text()).toContain('总请求');
        expect(wrapper.text()).toContain('真实消耗 Tokens');
        expect(wrapper.text()).toContain('缓存命中率');
        expect(wrapper.text()).toContain('12');
    });

    it('marks cost as a lower bound when some calls are unpriced', () => {
        setLocale('zh-CN');
        const wrapper = render({ totalCostMicros: 1_000_000, unpricedCount: 3 });

        // 未定价调用绝不当作 0 成本：合计前加 ≥，并单独标注次数
        expect(wrapper.text()).toContain('≥');
        expect(wrapper.text()).toContain('3');
        expect(wrapper.text()).toContain('未定价');
    });

    it('does not add the lower-bound marker when everything is priced', () => {
        setLocale('zh-CN');
        const wrapper = render({ totalCostMicros: 1_000_000, unpricedCount: 0 });

        expect(wrapper.text()).not.toContain('≥');
        expect(wrapper.text()).not.toContain('未定价');
    });

    it('shows zero values for an empty range instead of blanking out', () => {
        setLocale('zh-CN');
        const wrapper = render();

        expect(wrapper.text()).toContain('0');
        expect(wrapper.text()).toContain('0.0%');
    });

    it('reveals the secondary metrics only after expanding', async () => {
        setLocale('zh-CN');
        const wrapper = render({ inputTokens: 1234, outputTokens: 567 });

        expect(wrapper.text()).not.toContain('新增输入');

        await wrapper.get('button').trigger('click');

        expect(wrapper.text()).toContain('新增输入');
        expect(wrapper.text()).toContain('输出');
        expect(wrapper.text()).toContain('缓存写入');
        expect(wrapper.text()).toContain('缓存命中');
    });

    it('notes that reasoning tokens are already inside the output count', async () => {
        setLocale('zh-CN');
        const wrapper = render({ reasoningTokens: 900 });
        await wrapper.get('button').trigger('click');

        expect(wrapper.text()).toContain('其中推理');
        expect(wrapper.text()).toContain('已含在输出内');
    });

    it('switches card layout between compact and wide', () => {
        setLocale('zh-CN');
        const wide = render({}, false);
        const compact = render({}, true);

        expect(wide.html()).toContain('grid-cols-4');
        expect(compact.html()).toContain('grid-cols-2');
    });

    it('renders English copy when the locale is en-US', () => {
        setLocale('en-US');
        const wrapper = render({ requestCount: 5 });

        expect(wrapper.text()).toContain('Total cost');
        expect(wrapper.text()).toContain('Cache hit rate');

        setLocale('zh-CN');
    });
});
