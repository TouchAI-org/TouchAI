<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageHeatmapDay } from '@database/queries/usageStats';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { getLocale, t } from '@/i18n';

    import { formatCost, formatTokensCompact } from '../utils/format';
    import { localUsageKey } from '../utils/usageOverlay';

    const props = defineProps<{ days: UsageHeatmapDay[] }>();
    defineOptions({ name: 'UsageHeatmap' });

    /**
     * 固定展示最近一年（53 周）。
     *
     * 之前跟着筛选区间变化，短区间会变成一两列、长区间又超出一年，
     * 既失去日历感，也不方便横向比较。热力图的价值就是「一年里哪天在用」，
     * 所以横轴固定为周、纵轴固定为星期，由筛选只影响颜色深浅。
     */
    const WEEKS = 53;
    const CELL = 12;
    const STEP = 16;
    const WEEKDAYS = 7;

    /** 按日聚合（查询按小时返回，这里合并） */
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

    const bounds = computed(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // 最后一列对齐到本周六，保持七行完整
        const end = new Date(today);
        end.setDate(end.getDate() + (6 - end.getDay()));
        const start = new Date(end);
        start.setDate(start.getDate() - (WEEKS * WEEKDAYS - 1));
        return { today, start, end };
    });

    interface Cell {
        day: string;
        column: number;
        row: number;
        future: boolean;
        requests: number;
        tokens: number;
        costMicros: number;
    }

    const cells = computed<Cell[]>(() => {
        const { today, start, end } = bounds.value;
        const result: Cell[] = [];
        let offset = 0;

        for (const cursor = new Date(start); cursor <= end; offset += 1) {
            const day = localUsageKey(cursor);
            const entry = byDay.value.get(day);
            result.push({
                day,
                column: Math.floor(offset / WEEKDAYS),
                row: cursor.getDay(),
                future: cursor > today,
                requests: entry?.requests ?? 0,
                tokens: entry?.tokens ?? 0,
                costMicros: entry?.costMicros ?? 0,
            });
            cursor.setDate(cursor.getDate() + 1);
        }
        return result;
    });

    /** 只统计一年内的数据，避免图上画一年、文字说三年 */
    const inRange = computed(() => cells.value.filter((cell) => !cell.future));
    const activeDays = computed(() => inRange.value.filter((cell) => cell.requests > 0).length);
    const totalTokens = computed(() => inRange.value.reduce((sum, cell) => sum + cell.tokens, 0));

    /** 分位数阀值：用量长尾重，均值会让大多数日子挤在同一档 */
    const thresholds = computed(() => {
        const values = inRange.value
            .map((cell) => cell.tokens)
            .filter((value) => value > 0)
            .sort((left, right) => left - right);
        if (values.length === 0) return [0, 0, 0];
        return [0.5, 0.75, 0.9].map(
            (quantile) =>
                values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0
        );
    });

    function levelOf(tokens: number): number {
        if (tokens <= 0) return 0;
        for (let index = 2; index >= 0; index -= 1) {
            if (thresholds.value[index]! > 0 && tokens >= thresholds.value[index]!)
                return index + 2;
        }
        return 1;
    }

    const LEVEL_FILL = [
        'fill-neutral-100',
        'fill-neutral-200',
        'fill-neutral-300',
        'fill-neutral-500',
        'fill-neutral-800',
    ];
    const LEVEL_BG = [
        'bg-neutral-100',
        'bg-neutral-200',
        'bg-neutral-300',
        'bg-neutral-500',
        'bg-neutral-800',
    ];

    /** 月份标签：只标在出现新月份的第一列，且间隔不足 3 列时跳过以免叠字 */
    const monthLabels = computed(() => {
        const labels: Array<{ column: number; text: string }> = [];
        let lastMonth = '';

        for (const cell of cells.value) {
            const month = cell.day.slice(0, 7);
            if (month === lastMonth) continue;
            lastMonth = month;
            const previous = labels[labels.length - 1];
            if (previous && cell.column - previous.column < 3) continue;
            labels.push({
                column: cell.column,
                text: new Intl.DateTimeFormat(getLocale(), { month: 'short' }).format(
                    new Date(`${cell.day}T12:00:00`)
                ),
            });
        }
        return labels;
    });

    /** 行标签：只标隔行的星期首字，全部标会遮住格子 */
    const rowLabels = computed(() => {
        const formatter = new Intl.DateTimeFormat(getLocale(), { weekday: 'narrow' });
        return [1, 3, 5].map((row) => ({
            row,
            text: formatter.format(new Date(2026, 0, 4 + row)),
        }));
    });

    const width = computed(() => WEEKS * STEP);
    const height = computed(() => WEEKDAYS * STEP + 18);

    /** 宽度随容器缩放，但保持方格：只放大整体 viewBox */
    const containerRef = ref<HTMLElement | null>(null);
    const containerWidth = ref(0);
    const scale = computed(() => {
        const available = containerWidth.value - 44;
        if (available <= 0) return 1;
        return Math.max(1, available / width.value);
    });

    let observer: ResizeObserver | null = null;
    onMounted(() => {
        const el = containerRef.value;
        if (!el) return;
        containerWidth.value = el.clientWidth;
        observer = new ResizeObserver((entries) => {
            const next = entries[0]?.contentRect.width ?? 0;
            if (next > 0) containerWidth.value = next;
        });
        observer.observe(el);
    });
    onUnmounted(() => {
        observer?.disconnect();
        observer = null;
    });
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
            <div ref="containerRef" class="overflow-x-auto">
                <svg
                    :viewBox="`0 0 ${44 + width} ${height}`"
                    class="block w-full"
                    :style="{ height: `${Math.round(height * scale)}px` }"
                    role="img"
                    :aria-label="t('settings.usage.heatmap.title')"
                >
                    <text
                        v-for="label in monthLabels"
                        :key="`m-${label.column}`"
                        :x="44 + label.column * STEP"
                        y="9"
                        class="fill-neutral-400"
                        font-size="9"
                    >
                        {{ label.text }}
                    </text>

                    <text
                        v-for="label in rowLabels"
                        :key="`r-${label.row}`"
                        :x="38"
                        :y="18 + label.row * STEP + CELL * 0.8"
                        text-anchor="end"
                        class="fill-neutral-400"
                        font-size="9"
                    >
                        {{ label.text }}
                    </text>

                    <g transform="translate(44, 18)">
                        <rect
                            v-for="cell in cells"
                            :key="cell.day"
                            :data-day="cell.day"
                            :x="cell.column * STEP"
                            :y="cell.row * STEP"
                            :width="CELL"
                            :height="CELL"
                            rx="2.5"
                            :class="
                                cell.future ? 'fill-transparent' : LEVEL_FILL[levelOf(cell.tokens)]
                            "
                        >
                            <title v-if="!cell.future">
                                {{
                                    t('settings.usage.heatmap.tooltip', {
                                        day: cell.day,
                                        requests: cell.requests,
                                        tokens: formatTokensCompact(cell.tokens),
                                        cost: formatCost(cell.costMicros),
                                    })
                                }}
                            </title>
                        </rect>
                    </g>
                </svg>
            </div>

            <div class="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
                <span>{{ t('settings.usage.heatmap.less') }}</span>
                <span
                    v-for="(className, index) in LEVEL_BG"
                    :key="index"
                    :class="['h-2.5 w-2.5 rounded-sm', className]"
                    aria-hidden="true"
                />
                <span>{{ t('settings.usage.heatmap.more') }}</span>
            </div>
        </div>
    </section>
</template>
