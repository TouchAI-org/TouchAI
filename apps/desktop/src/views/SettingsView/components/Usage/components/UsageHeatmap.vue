<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import ActivityHeatmap from '@components/ui/activity-heatmap/ActivityHeatmap.vue';
    import type { UsageHeatmapDay } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { getLocale, t } from '@/i18n';

    import { formatCost, formatInt, formatTokensCompact } from '../utils/format';

    const props = defineProps<{ days: UsageHeatmapDay[] }>();
    defineOptions({ name: 'UsageHeatmap' });

    /** 按日聚合：查询按小时返回，热力图按天画 */
    const byDay = computed(() => {
        const map = new Map<string, { requests: number; tokens: number; costMicros: number }>();
        for (const row of props.days) {
            const entry = map.get(row.day) ?? { requests: 0, tokens: 0, costMicros: 0 };
            entry.requests += row.requests;
            entry.tokens += row.tokens;
            entry.costMicros += row.costMicros;
            map.set(row.day, entry);
        }
        return map;
    });

    /**
     * 一年窗口的起止日期（与 ActivityHeatmap 的 yearWindow 一致）。
     *
     * 汇总必须用同一个窗口：图上只画一年，文字却把三年前的用量算进去，
     * 两个数字就对不上了。
     */
    const window = computed(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const end = new Date(today);
        // 对齐到本周最后一天（周一开头）
        const tail = (7 - ((end.getDay() - 1 + 7) % 7) - 1) % 7;
        end.setDate(end.getDate() + tail);
        const start = new Date(end);
        start.setDate(start.getDate() - 364);
        return { start, end };
    });

    /** 只保留窗口内的日子，与图上画的格子一一对应 */
    const inWindow = computed(() => {
        const { start, end } = window.value;
        const rows: Array<{ date: string; requests: number; tokens: number; costMicros: number }> =
            [];
        for (const [date, entry] of byDay.value) {
            const at = new Date(`${date}T00:00:00`);
            if (at < start || at > end) continue;
            rows.push({ date, ...entry });
        }
        return rows;
    });

    const activity = computed(() =>
        inWindow.value.map((entry) => ({ date: entry.date, count: entry.requests }))
    );

    /** 只统计有请求的日子与总量 */
    const activeDays = computed(() => inWindow.value.filter((entry) => entry.requests > 0).length);
    const totalTokens = computed(() =>
        inWindow.value.reduce((sum, entry) => sum + entry.tokens, 0)
    );

    const units = computed(() =>
        getLocale() === 'zh-CN'
            ? { one: '次请求', other: '次请求' }
            : { one: 'call', other: 'calls' }
    );

    /** 气泡第二行：token 与成本 */
    function detailOf(date: string): string | null {
        const entry = byDay.value.get(date);
        if (!entry || entry.requests === 0) return null;
        return `${formatTokensCompact(entry.tokens)} tokens · ${formatCost(entry.costMicros)}`;
    }

    function formatDate(date: Date): string {
        return new Intl.DateTimeFormat(getLocale(), {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(date);
    }
</script>

<template>
    <section class="space-y-3" data-testid="settings-usage-heatmap">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="settings-section-title">{{ t('settings.usage.heatmap.title') }}</h2>
            <span class="text-[11px] text-neutral-500">
                {{
                    t('settings.usage.heatmap.yearSummary', {
                        days: activeDays,
                        tokens: formatTokensCompact(totalTokens),
                    })
                }}
            </span>
        </div>

        <div class="rounded-[11px] bg-neutral-50/80 p-4">
            <!-- 热力图固定展示近一年，由筛选只影响深浅 -->
            <ActivityHeatmap
                :days="activity"
                :label="t('settings.usage.heatmap.title')"
                year-window
                :week-starts-on="1"
                :unit="units"
                :format-value="formatInt"
                :format-date="formatDate"
                :detail-of="detailOf"
            />
        </div>
    </section>
</template>
