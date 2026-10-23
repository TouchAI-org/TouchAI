// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { ToolUsageSummary } from '@database/queries/usageStats';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import UsageToolStats from '@/views/SettingsView/components/Usage/components/UsageToolStats.vue';

function tool(name: string, count: number, meanDurationMs: number | null = 1000) {
    return {
        name,
        kind: name.startsWith('mcp__') ? ('mcp' as const) : ('builtin' as const),
        count,
        errorCount: 0,
        meanDurationMs,
    };
}

const summary: ToolUsageSummary = {
    totalCount: 60,
    errorCount: 6,
    distinctTools: 3,
    meanDurationMs: 1500,
    byTool: [tool('builtin__read', 30), tool('builtin__bash', 20), tool('mcp__server__search', 10)],
};

function mountStats(stats: ToolUsageSummary = summary, loading = false) {
    return mount(UsageToolStats, { props: { stats, loading } });
}

beforeEach(() => setLocale('zh-CN'));

describe('user reviews tool usage', () => {
    it('user sees the totals, the distinct tool count, the failure rate and the mean duration', () => {
        const wrapper = mountStats();

        expect(wrapper.text()).toContain('工具调用');
        expect(wrapper.text()).toContain('用到的工具');
        // 6 of 60 calls failed.
        expect(wrapper.text()).toContain('10.0%');
        expect(wrapper.text()).toContain('1.5s');
    });

    it('user sees a red failure rate only when a tool actually failed', async () => {
        const wrapper = mountStats();
        const rate = wrapper.get('[data-testid="settings-usage-tools"]');

        expect(rate.html()).toContain('text-red-600');

        await wrapper.setProps({ stats: { ...summary, errorCount: 0 } });

        expect(wrapper.html()).not.toContain('text-red-600');
    });

    it('user sees the built-in prefix stripped but the MCP server prefix kept readable', () => {
        const wrapper = mountStats();

        expect(wrapper.text()).toContain('read');
        expect(wrapper.text()).not.toContain('builtin__read');
        expect(wrapper.text()).toContain('search');
        expect(wrapper.text()).not.toContain('mcp__server__search');
    });

    it('user sees the extra tools folded into an "other" slice once more than five are used', () => {
        const wrapper = mountStats({
            ...summary,
            totalCount: 210,
            distinctTools: 7,
            byTool: [
                tool('builtin__a', 60),
                tool('builtin__b', 50),
                tool('builtin__c', 40),
                tool('builtin__d', 30),
                tool('builtin__e', 20),
                tool('builtin__f', 6),
                tool('builtin__g', 4),
            ],
        });

        expect(wrapper.text()).toContain('其他');
        expect(wrapper.text()).toContain('另有 2 个工具未列出');
    });

    it('user sees no "other" note when every tool fits', () => {
        const wrapper = mountStats();

        expect(wrapper.text()).not.toContain('其他');
        expect(wrapper.text()).not.toContain('未列出');
    });

    it('user is told there were no tool calls instead of seeing an empty chart', () => {
        const wrapper = mountStats({
            totalCount: 0,
            errorCount: 0,
            distinctTools: 0,
            meanDurationMs: null,
            byTool: [],
        });

        expect(wrapper.text()).toContain('这段时间没有工具调用');
    });

    it('user sees a placeholder layout while the tool stats are still loading', () => {
        const wrapper = mountStats(
            { totalCount: 0, errorCount: 0, distinctTools: 0, meanDurationMs: null, byTool: [] },
            true
        );

        expect(wrapper.find('[data-testid="settings-usage-tools-loading"]').exists()).toBe(true);
        expect(wrapper.text()).not.toContain('这段时间没有工具调用');
    });

    it('user sees the English labels when the app is in English', () => {
        setLocale('en-US');

        const wrapper = mountStats();

        expect(wrapper.text()).toContain('Tool calls');
        expect(wrapper.text()).toContain('Tools used');
        expect(wrapper.text()).toContain('Failure rate');
    });
});
