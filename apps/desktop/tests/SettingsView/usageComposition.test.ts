import type { UsageComposition } from '@database/queries/usageStats';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import UsageCompositionPanel from '@/views/SettingsView/components/Usage/components/UsageComposition.vue';

const composition: UsageComposition = {
    tokens: {
        total: 1_000_000,
        segments: [
            { key: 'systemPrompt', value: 560_000, estimated: true },
            { key: 'toolDefinitions', value: 170_000, estimated: true },
            { key: 'toolResults', value: 110_000, estimated: true },
            { key: 'output', value: 160_000, estimated: false },
        ],
    },
    timing: {
        totalMs: 600_000,
        segments: [
            { key: 'wait', value: 200_000, estimated: false },
            { key: 'reply', value: 300_000, estimated: false },
            { key: 'tool', value: 100_000, estimated: false },
        ],
    },
    cacheReadShare: 0.777,
};

function mountPanel(value: UsageComposition = composition) {
    return mount(UsageCompositionPanel, {
        props: { composition: value },
        global: { stubs: {} },
    });
}

beforeEach(() => setLocale('zh-CN'));

describe('usage composition panel', () => {
    it('renders one ring slice per non-empty segment', () => {
        const wrapper = mountPanel();

        // 两张卡各一个底环 + 各段
        const tokenSlices = wrapper.findAll('[data-testid^="settings-usage-composition-token-"]');
        expect(tokenSlices).toHaveLength(4);

        const timingSlices = wrapper.findAll('[data-testid^="settings-usage-composition-timing-"]');
        expect(timingSlices).toHaveLength(3);
    });

    it('marks estimated values and leaves measured ones unmarked', () => {
        const wrapper = mountPanel();

        const systemPrompt = wrapper.get(
            '[data-testid="settings-usage-composition-token-systemPrompt"]'
        );
        const output = wrapper.get('[data-testid="settings-usage-composition-token-output"]');

        expect(systemPrompt.text()).toContain('≈');
        expect(output.text()).not.toContain('≈');
        expect(output.text()).toContain('16.0%');
    });

    it('shows the cache hit share as a note rather than a slice', () => {
        const wrapper = mountPanel();

        expect(wrapper.text()).toContain('77.7%');
        expect(
            wrapper.find('[data-testid="settings-usage-composition-token-cacheRead"]').exists()
        ).toBe(false);
    });

    it('localizes labels and units together', () => {
        setLocale('en-US');
        const wrapper = mountPanel();

        expect(wrapper.text()).toContain('System prompt');
        expect(wrapper.text()).toContain('Model reply');
        expect(wrapper.text()).toContain('Token composition');
        expect(wrapper.text()).not.toContain('系统提示词');
    });

    it('renders an empty state instead of an empty ring', () => {
        const wrapper = mountPanel({
            tokens: { total: 0, segments: [] },
            timing: { totalMs: 0, segments: [] },
            cacheReadShare: 0,
        });

        expect(wrapper.text()).toContain('这段时间没有可拆分的用量');
        expect(wrapper.findAll('circle')).toHaveLength(0);
    });
});
