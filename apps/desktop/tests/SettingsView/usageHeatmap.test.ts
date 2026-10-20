import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import UsageHeatmap from '@/views/SettingsView/components/Usage/components/UsageHeatmap.vue';

function dbTime(date: Date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

describe('usage heatmap range', () => {
    it('includes all selected days even when a seven-day range spans two calendar weeks', () => {
        setLocale('zh-CN');
        const start = new Date(2026, 4, 1, 12);
        const end = new Date(2026, 4, 8, 12);
        const wrapper = mount(UsageHeatmap, {
            props: {
                days: [
                    { day: '2026-05-01', requests: 1, tokens: 100, costMicros: 0 },
                    { day: '2026-05-08', requests: 1, tokens: 200, costMicros: 0 },
                ],
                range: { preset: '7d', from: dbTime(start), to: dbTime(end) },
            },
        });
        expect(wrapper.findAll('[data-day]')).toHaveLength(8);
        expect(wrapper.find('[data-day="2026-05-01"]').exists()).toBe(true);
        expect(wrapper.find('[data-day="2026-05-08"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('所选区间活跃 2 天');
        expect(wrapper.get('svg').attributes('height')).toBe('114');
        expect(wrapper.get('svg').classes()).not.toContain('w-full');
    });

    it('anchors a historical custom range to that range instead of today', () => {
        const wrapper = mount(UsageHeatmap, {
            props: {
                days: [],
                range: {
                    preset: 'custom',
                    from: dbTime(new Date(2020, 0, 1)),
                    to: dbTime(new Date(2020, 0, 2, 23)),
                },
            },
        });
        expect(
            wrapper.findAll('[data-day]').map((element) => element.attributes('data-day'))
        ).toEqual(['2020-01-01', '2020-01-02']);
    });
});
