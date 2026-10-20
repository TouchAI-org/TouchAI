import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import UsageHeatmap from '@/views/SettingsView/components/Usage/components/UsageHeatmap.vue';

function dbTime(date: Date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function cell(day: string, hour: number, tokens: number) {
    return { day, hour, requests: 1, tokens, costMicros: 0 };
}

describe('usage heatmap granularity', () => {
    it('uses an hour-by-day grid for short ranges', () => {
        setLocale('zh-CN');
        const wrapper = mount(UsageHeatmap, {
            props: {
                days: [cell('2026-05-01', 9, 100), cell('2026-05-01', 14, 200)],
                range: {
                    preset: '7d',
                    from: dbTime(new Date(2026, 4, 1, 0)),
                    to: dbTime(new Date(2026, 4, 1, 23)),
                },
            },
        });

        // 单天区间：24 小时为列、1 天为行，同一小时的多次调用合并到一格
        const cells = wrapper.findAll('[data-day]');
        expect(cells).toHaveLength(24);
        expect(wrapper.text()).toContain('1 天');
        expect(wrapper.text()).toContain('2 个时段');
        expect(wrapper.text()).toContain('06:00');
        // 列数是 24，说明铺满了宽度而不是只剩一列
        expect(wrapper.get('svg').attributes('viewBox')).toBe('0 0 370 30');
    });

    it('switches to a weekday-by-week grid for long ranges', () => {
        setLocale('zh-CN');
        const wrapper = mount(UsageHeatmap, {
            props: {
                days: [cell('2026-05-01', 9, 100)],
                range: {
                    preset: '30d',
                    from: dbTime(new Date(2026, 3, 1, 0)),
                    to: dbTime(new Date(2026, 4, 1, 23)),
                },
            },
        });

        const cells = wrapper.findAll('[data-day]');
        // 31 天跨度按周铺开，至少 31 个日格
        expect(cells.length).toBeGreaterThanOrEqual(31);
        expect(wrapper.text()).toContain('1 天');
        expect(wrapper.text()).not.toContain('个时段');
        expect(wrapper.text()).not.toContain('06:00');
    });

    it('keeps the same day data regardless of which grid renders it', () => {
        const days = [cell('2026-05-01', 9, 500)];
        const short = mount(UsageHeatmap, {
            props: {
                days,
                range: {
                    preset: '7d',
                    from: dbTime(new Date(2026, 4, 1, 0)),
                    to: dbTime(new Date(2026, 4, 1, 23)),
                },
            },
        });
        const long = mount(UsageHeatmap, {
            props: {
                days,
                range: {
                    preset: '30d',
                    from: dbTime(new Date(2026, 3, 1, 0)),
                    to: dbTime(new Date(2026, 4, 1, 23)),
                },
            },
        });

        // 两种尺度下同一天的总量必须一致，否则切换区间会看到不同的数字
        for (const wrapper of [short, long]) {
            expect(wrapper.text()).toContain('500');
        }
    });
});
