import type { UsageComposition } from '@database/queries/usageStats';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import UsageCompositionPanel from '@/views/SettingsView/components/Usage/components/UsageComposition.vue';

/** jsdom 没有 rAF 循环所需的布局能力；给一个不驱动动画的桩 */
class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}

beforeEach(() => {
    setLocale('zh-CN');
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    // 让 rAF 立即执行一次，但不持续调度
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

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

function mountPanel(value: UsageComposition | null = composition) {
    return mount(UsageCompositionPanel, { props: { composition: value } });
}

describe('user breaks down token usage', () => {
    it('user sees one legend row per segment', () => {
        const wrapper = mountPanel();

        // 两张环图各有一组图例按钮
        const legendButtons = wrapper.findAll('figure button');
        expect(legendButtons).toHaveLength(7);
    });

    it('user marks estimated values with a tilde and leaves measured ones clean', () => {
        const wrapper = mountPanel();

        const text = wrapper.text();
        // 系统提示词是估算的
        expect(text).toContain('≈56万');
        // 输出是供应商实测值，不带 ≈
        expect(text).toContain('16万');
        expect(text).not.toContain('≈16万');
    });

    it('user sees the cache hit share as a note rather than a slice', () => {
        const wrapper = mountPanel();

        expect(wrapper.text()).toContain('77.7%');
        // 缓存读取不进内容构成
        expect(wrapper.text()).not.toContain('缓存读取');
    });

    it('user sees labels together', () => {
        setLocale('en-US');
        const wrapper = mountPanel();

        expect(wrapper.text()).toContain('System prompt');
        expect(wrapper.text()).toContain('Model reply');
        expect(wrapper.text()).not.toContain('系统提示词');
    });

    it('user sees a skeleton instead of an empty ring while loading', () => {
        const wrapper = mountPanel(null);

        expect(wrapper.find('.animate-pulse').exists()).toBe(true);
        expect(wrapper.findAll('figure button')).toHaveLength(0);
    });

    it('user sees an empty state when there is nothing to break down', () => {
        const wrapper = mountPanel({
            tokens: { total: 0, segments: [] },
            timing: { totalMs: 0, segments: [] },
            cacheReadShare: 0,
        });

        expect(wrapper.text()).toContain('这段时间没有可拆分的用量');
    });
});
