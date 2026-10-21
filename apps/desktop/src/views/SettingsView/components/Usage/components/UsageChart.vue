<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import BarChart from '@components/ui/bar-chart/BarChart.vue';
    import type { UsageTrendPoint } from '@database/queries/usageStats';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';

    import {
        formatCostCompact,
        formatDayLabel,
        formatInt,
        formatTokensCompact,
    } from '../utils/format';

    type Metric = 'tokens' | 'requests' | 'cost';
    type Dimension = 'model' | 'provider';

    interface Props {
        points: UsageTrendPoint[];
        bucket: 'minute' | 'hour' | 'day';
        dimension: Dimension;
        /** 只展示前 N 个分组，其余归入「其他」 */
        maxSeries?: number;
    }

    const props = withDefaults(defineProps<Props>(), { maxSeries: 5 });

    const emit = defineEmits<{ (event: 'update:dimension', value: Dimension): void }>();

    defineOptions({ name: 'UsageChart' });

    const metric = ref<Metric>('tokens');

    const METRIC_OPTIONS: Metric[] = ['tokens', 'requests', 'cost'];

    /** 与环图、曲线共用同一套色板 */
    const PALETTE = [
        'rgb(63 63 70)',
        'rgb(14 165 233)',
        'rgb(16 185 129)',
        'rgb(245 158 11)',
        'rgb(139 92 246)',
    ];
    const OTHER_COLOR = 'rgb(212 212 212)';

    function valueOf(input: { tokens: number; requests: number; costMicros: number }): number {
        if (metric.value === 'requests') return input.requests;
        if (metric.value === 'cost') return input.costMicros / 1_000_000;
        return input.tokens;
    }

    /** 全期间的 top N 分组；其余合并为「其他」 */
    const series = computed(() => {
        const totals = new Map<string, number>();
        for (const point of props.points) {
            for (const segment of point.segments) {
                totals.set(segment.name, (totals.get(segment.name) ?? 0) + valueOf(segment));
            }
        }

        const ranked = [...totals.entries()].sort((left, right) => right[1] - left[1]);
        const top = ranked.slice(0, props.maxSeries).map(([name]) => name);
        const hasOther = ranked.length > top.length;

        return [
            ...top.map((name, index) => ({
                key: name,
                label: name,
                color: PALETTE[index % PALETTE.length]!,
            })),
            ...(hasOther
                ? [{ key: '__other', label: t('settings.usage.chart.other'), color: OTHER_COLOR }]
                : []),
        ];
    });

    /** 每个时间桶一根柱 */
    const data = computed(() =>
        props.points.map((point) => {
            const values: Record<string, number> = {};
            let other = 0;

            for (const segment of point.segments) {
                if (series.value.some((entry) => entry.key === segment.name)) {
                    values[segment.name] = valueOf(segment);
                } else {
                    other += valueOf(segment);
                }
            }
            if (series.value.some((entry) => entry.key === '__other')) {
                values['__other'] = other;
            }

            const label =
                props.bucket === 'day' ? formatDayLabel(point.key) : point.key.slice(11, 16);

            return { key: point.key, label, axisLabel: label, values };
        })
    );

    function formatValue(value: number): string {
        if (metric.value === 'cost') return formatCostCompact(value * 1_000_000);
        if (metric.value === 'requests') return formatInt(Math.round(value));
        return formatTokensCompact(Math.round(value));
    }

    /** 纵轴用更紧凑的形式，避免 5 个刻度把左侧挤满 */
    function formatTick(value: number): string {
        if (metric.value === 'cost') return formatCostCompact(value * 1_000_000);
        if (metric.value === 'requests') return formatInt(Math.round(value));
        return formatTokensCompact(Math.round(value));
    }
</script>

<template>
    <section class="space-y-3" data-testid="settings-usage-chart">
        <!-- 小标题与切换留在卡外，与首屏卡片保持同一套节奏 -->
        <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="settings-section-title">
                {{ t('settings.usage.chart.title') }}
            </h2>

            <div class="flex items-center gap-1">
                <button
                    v-for="option in ['model', 'provider'] as Dimension[]"
                    :key="option"
                    type="button"
                    :class="[
                        'rounded-[10px] px-2.5 py-1 text-[11px] transition-colors',
                        dimension === option
                            ? 'bg-[#e9e9e7] text-neutral-950'
                            : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                    ]"
                    :aria-pressed="dimension === option"
                    @click="emit('update:dimension', option)"
                >
                    {{ t(`settings.usage.breakdown.by.${option}`) }}
                </button>

                <span class="mx-1 h-4 w-px bg-neutral-300" aria-hidden="true" />

                <button
                    v-for="option in METRIC_OPTIONS"
                    :key="option"
                    type="button"
                    :class="[
                        'rounded-[10px] px-2.5 py-1 text-[11px] transition-colors',
                        metric === option
                            ? 'bg-[#e9e9e7] text-neutral-950'
                            : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                    ]"
                    :aria-pressed="metric === option"
                    @click="metric = option"
                >
                    {{ t(`settings.usage.trend.metric.${option}`) }}
                </button>
            </div>
        </div>

        <div class="rounded-[11px] bg-neutral-50/80 p-4">
            <BarChart
                :data="data"
                :series="series"
                :label="t('settings.usage.chart.title')"
                :height="208"
                :format-value="formatValue"
                :format-tick="formatTick"
                :empty-label="t('settings.usage.trend.empty')"
            />
        </div>
    </section>
</template>
