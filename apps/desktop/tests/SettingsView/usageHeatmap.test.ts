import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import UsageHeatmap from '@/views/SettingsView/components/Usage/components/UsageHeatmap.vue';

/** jsdom 没有 ResizeObserver；给一个不触发回调的桩 */
class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

function cell(day: string, hour: number, tokens: number) {
    return { day, hour, requests: 1, tokens, costMicros: 0 };
}

/** 用本地日期生成「今天」以及几天前的日期键 */
function dayKey(daysAgo: number): string {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - daysAgo);
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
    ].join('-');
}

describe('user reads the activity heatmap', () => {
    it('user always renders a full year of weeks regardless of the filter range', () => {
        setLocale('zh-CN');
        const wrapper = mount(UsageHeatmap, {
            props: { days: [cell(dayKey(0), 9, 100), cell(dayKey(0), 14, 200)] },
        });

        // 固定一年窗口：365 天，最后一行完整
        const cells = wrapper.findAll('[data-day]');
        expect(cells).toHaveLength(365);
        expect(wrapper.text()).toContain('近一年');
        // 同一天的两个小时合并成一格
        expect(wrapper.text()).toContain('300');
    });

    it('user ignores days outside the past year so the summary matches the grid', () => {
        const wrapper = mount(UsageHeatmap, {
            props: { days: [cell('2000-01-01', 9, 999_999), cell(dayKey(0), 9, 100)] },
        });

        // 一年前的数据不应出现在格子里，也不该计入汇总
        expect(wrapper.find('[data-day="2000-01-01"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('99.9万');
    });

    it('user keeps day totals identical no matter which hour the data arrives in', () => {
        const single = mount(UsageHeatmap, { props: { days: [cell(dayKey(0), 9, 500)] } });
        const split = mount(UsageHeatmap, {
            props: { days: [cell(dayKey(0), 9, 250), cell(dayKey(0), 20, 250)] },
        });

        expect(single.text()).toContain('500');
        expect(split.text()).toContain('500');
    });
});
