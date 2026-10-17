<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageHeatmapDay } from '@database/queries/usageStats';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';

    import { formatCost, formatDayLabel, formatInt, formatTokensCompact } from '../utils/format';

    type HeatMetric = 'tokens' | 'requests' | 'cost';

    interface Props {
        days: UsageHeatmapDay[];
        compact: boolean;
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageHeatmap' });

    const WEEKS = 53;
    const CELL = 10;
    const GAP = 3;

    const metric = ref<HeatMetric>('tokens');
    const hovered = ref<{ day: UsageHeatmapDay; x: number; y: number } | null>(null);

    const METRIC_OPTIONS: HeatMetric[] = ['tokens', 'requests', 'cost'];

    function valueOf(day: UsageHeatmapDay): number {
        if (metric.value === 'requests') return day.requests;
        if (metric.value === 'cost') return day.costMicros / 1_000_000;
        return day.tokens;
    }

    const byDay = computed(() => new Map(props.days.map((day) => [day.day, day])));

    /** 从今天往前推 53 周的周一作为起点 */
    const gridStart = computed(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // 周一为一周之首：getDay() 周日为 0
        const weekday = (today.getDay() + 6) % 7;
        const start = new Date(today);
        start.setDate(start.getDate() - weekday - (WEEKS - 1) * 7);
        return start;
    });

    const maxValue = computed(() => Math.max(1, ...props.days.map(valueOf)));

    function dayKey(date: Date): string {
        const pad = (value: number) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    interface Cell {
        key: string;
        label: string;
        x: number;
        y: number;
        level: number;
        data: UsageHeatmapDay | undefined;
    }

    const cells = computed<Cell[]>(() => {
        const result: Cell[] = [];
        const start = gridStart.value;
        const now = new Date();
        now.setHours(23, 59, 59, 999);

        for (let week = 0; week < WEEKS; week += 1) {
            for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
                const date = new Date(start);
                date.setDate(start.getDate() + week * 7 + dayOfWeek);
                if (date > now) continue;

                const key = dayKey(date);
                const data = byDay.value.get(key);
                const value = data ? valueOf(data) : 0;
                // 0 值单独一档；其余按最大值分 4 档，保证小量级也可见
                const level = value <= 0 ? 0 : Math.min(4, Math.ceil((value / maxValue.value) * 4));

                result.push({
                    key,
                    label: formatDayLabel(key),
                    x: week * (CELL + GAP),
                    y: dayOfWeek * (CELL + GAP),
                    level,
                    data,
                });
            }
        }
        return result;
    });

    const width = computed(() => WEEKS * (CELL + GAP) - GAP);
    const height = computed(() => 7 * (CELL + GAP) - GAP);

    const LEVEL_CLASS = [
        'fill-neutral-100',
        'fill-neutral-300',
        'fill-neutral-400',
        'fill-neutral-600',
        'fill-neutral-800',
    ];

    const monthLabels = computed(() => {
        const labels: Array<{ x: number; text: string }> = [];
        let lastMonth = -1;
        const start = gridStart.value;
        for (let week = 0; week < WEEKS; week += 1) {
            const date = new Date(start);
            date.setDate(start.getDate() + week * 7);
            const month = date.getMonth();
            if (month !== lastMonth) {
                lastMonth = month;
                labels.push({ x: week * (CELL + GAP), text: `${month + 1}` });
            }
        }
        return labels;
    });

    const summaryText = computed(() => {
        const activeDays = props.days.length;
        const totalTokens = props.days.reduce((sum, day) => sum + day.tokens, 0);
        return t('settings.usage.heatmap.summary', {
            days: activeDays,
            tokens: formatTokensCompact(totalTokens),
        });
    });

    function hoverText(day: UsageHeatmapDay): string {
        return t('settings.usage.heatmap.tooltip', {
            day: day.day,
            requests: formatInt(day.requests),
            tokens: formatTokensCompact(day.tokens),
            cost: formatCost(day.costMicros),
        });
    }
</script>

<template>
    <section class="flex flex-col gap-2 rounded-[13px] border border-neutral-200/70 bg-white p-3">
        <div class="flex items-center justify-between gap-3">
            <div class="flex flex-col">
                <span class="text-xs font-medium tracking-wide text-neutral-500">
                    {{ t('settings.usage.heatmap.title') }}
                </span>
                <span class="text-[11px] text-neutral-400">{{ summaryText }}</span>
            </div>
            <div class="flex items-center gap-0.5 rounded-[8px] bg-neutral-100 p-[3px]">
                <button
                    v-for="option in METRIC_OPTIONS"
                    :key="option"
                    type="button"
                    :class="[
                        'rounded-[6px] px-2.5 py-1 text-[11px] transition-colors',
                        metric === option
                            ? 'bg-white font-semibold text-neutral-900 shadow-sm'
                            : 'text-neutral-500 hover:text-neutral-800',
                    ]"
                    :aria-pressed="metric === option"
                    @click="metric = option"
                >
                    {{ t(`settings.usage.trend.metric.${option}`) }}
                </button>
            </div>
        </div>

        <div v-if="days.length === 0" class="flex h-20 items-center justify-center">
            <span class="text-xs text-neutral-400">{{ t('settings.usage.trend.empty') }}</span>
        </div>

        <div v-else class="relative overflow-x-auto">
            <svg
                :viewBox="`-24 0 ${width + 24} ${height + 14}`"
                class="h-auto w-full min-w-[560px]"
            >
                <!-- 月份标签 -->
                <text
                    v-for="label in monthLabels"
                    :key="`month-${label.x}`"
                    :x="label.x"
                    :y="height + 10"
                    class="fill-neutral-400"
                    font-size="8"
                >
                    {{ label.text }}
                </text>

                <rect
                    v-for="cell in cells"
                    :key="cell.key"
                    :x="cell.x"
                    :y="cell.y"
                    :width="CELL"
                    :height="CELL"
                    rx="2"
                    :class="LEVEL_CLASS[cell.level]"
                    @mouseenter="
                        hovered = {
                            day: cell.data ?? {
                                day: cell.key,
                                requests: 0,
                                tokens: 0,
                                costMicros: 0,
                            },
                            x: cell.x,
                            y: cell.y,
                        }
                    "
                    @mouseleave="hovered = null"
                />
            </svg>

            <div
                v-if="hovered"
                class="pointer-events-none absolute top-0 z-10 rounded-[8px] border border-neutral-200 bg-white px-2.5 py-1.5 text-[11px] whitespace-nowrap shadow-sm"
                :style="{ left: `${Math.min(72, (hovered.x / width) * 100)}%` }"
            >
                {{ hoverText(hovered.day) }}
            </div>
        </div>

        <!-- 图例 -->
        <div class="flex items-center justify-end gap-1 text-[10px] text-neutral-400">
            <span>{{ t('settings.usage.heatmap.less') }}</span>
            <span
                v-for="(cls, index) in LEVEL_CLASS"
                :key="index"
                :class="['h-2.5 w-2.5 rounded-[2px]', cls.replace('fill-', 'bg-')]"
            />
            <span>{{ t('settings.usage.heatmap.more') }}</span>
        </div>
    </section>
</template>
