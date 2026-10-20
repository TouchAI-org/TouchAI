<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageBucket, UsageTrendPoint } from '@database/queries/usageStats';
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
        bucket: UsageBucket;
        dimension: Dimension;
        /** 只展示前 N 个分组，其余归入「其他」，避免颜色过多无法分辨 */
        maxSeries?: number;
    }

    const props = withDefaults(defineProps<Props>(), { maxSeries: 5 });

    const emit = defineEmits<{ (event: 'update:dimension', value: Dimension): void }>();

    defineOptions({ name: 'UsageChart' });

    const metric = ref<Metric>('tokens');

    const METRIC_OPTIONS: Array<{ value: Metric; labelKey: 'tokens' | 'requests' | 'cost' }> = [
        { value: 'tokens', labelKey: 'tokens' },
        { value: 'requests', labelKey: 'requests' },
        { value: 'cost', labelKey: 'cost' },
    ];

    /** 与「上下文构成」共用同一套色板语义：先深后浅，最后一段固定为中性灰 */
    const PALETTE = [
        'rgb(63 63 70)',
        'rgb(14 165 233)',
        'rgb(16 185 129)',
        'rgb(245 158 11)',
        'rgb(139 92 246)',
        'rgb(163 163 163)',
    ];
    const OTHER_COLOR = 'rgb(212 212 212)';

    const PADDING = { top: 10, right: 6, bottom: 20, left: 46 };
    const VIEW_WIDTH = 720;
    const height = 168;
    const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
    const innerHeight = height - PADDING.top - PADDING.bottom;

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
                name,
                color: PALETTE[index % PALETTE.length]!,
            })),
            ...(hasOther ? [{ name: t('settings.usage.chart.other'), color: OTHER_COLOR }] : []),
        ];
    });

    /** 每个桶按 series 顺序展开成堆叠段 */
    const bars = computed(() => {
        const ordered = series.value.map((entry) => entry.name);
        const otherLabel = t('settings.usage.chart.other');

        return props.points.map((point) => {
            const byName = new Map<string, number>();
            for (const segment of point.segments) {
                const bucketName = ordered.includes(segment.name) ? segment.name : otherLabel;
                byName.set(bucketName, (byName.get(bucketName) ?? 0) + valueOf(segment));
            }

            const total = [...byName.values()].reduce((sum, value) => sum + value, 0);
            return { key: point.key, total, byName, source: point };
        });
    });

    const maxValue = computed(() => Math.max(1, ...bars.value.map((bar) => bar.total)));

    /** 全期各分组合计，供图例 tooltip 展示总量 */
    const seriesTotals = computed(() => {
        const totals = new Map<string, number>();
        for (const bar of bars.value) {
            for (const [name, value] of bar.byName) {
                totals.set(name, (totals.get(name) ?? 0) + value);
            }
        }
        return totals;
    });

    const geometry = computed(() => {
        const items = bars.value;
        if (items.length === 0) return [];

        const slot = items.length === 0 ? innerWidth : innerWidth / items.length;
        const barWidth = Math.max(2, Math.min(28, slot * 0.7));

        return items.map((bar, index) => ({
            ...bar,
            index,
            x: PADDING.left + slot * index + (slot - barWidth) / 2,
            width: barWidth,
            slot,
        }));
    });

    /** 自下而上堆叠 */
    function stackOf(bar: (typeof geometry.value)[number]) {
        let y = PADDING.top + innerHeight;
        const rects: Array<{ name: string; color: string; y: number; height: number }> = [];

        for (const entry of series.value) {
            const value = bar.byName.get(entry.name) ?? 0;
            if (value <= 0) continue;

            const segmentHeight = (value / maxValue.value) * innerHeight;
            y -= segmentHeight;
            rects.push({ name: entry.name, color: entry.color, y, height: segmentHeight });
        }

        return rects;
    }

    const yTicks = computed(() =>
        [0, 0.5, 1].map((ratio) => ({
            y: PADDING.top + innerHeight * (1 - ratio),
            label:
                metric.value === 'cost'
                    ? formatCostCompact(maxValue.value * ratio * 1_000_000)
                    : metric.value === 'requests'
                      ? formatInt(Math.round(maxValue.value * ratio))
                      : formatTokensCompact(Math.round(maxValue.value * ratio)),
        }))
    );

    const labelIndices = computed(() => {
        const total = geometry.value.length;
        if (total === 0) return [];
        const step = total <= 8 ? 1 : Math.ceil(total / 6);
        const indices = geometry.value.filter((_, index) => index % step === 0).map((b) => b.index);
        if (indices.length > 1) {
            const last = indices[indices.length - 1]!;
            const previous = indices[indices.length - 2]!;
            if (last - previous < step / 2) indices.pop();
        }
        return indices;
    });

    function labelOf(key: string): string {
        if (props.bucket === 'minute') return key.slice(11, 16);
        if (props.bucket === 'hour') return key.slice(11, 16);
        return formatDayLabel(key);
    }

    // ===== 悬停提示 =====

    const hoveredIndex = ref<number | null>(null);

    const hovered = computed(() => {
        const index = hoveredIndex.value;
        if (index === null) return null;
        const bar = geometry.value[index];
        if (!bar) return null;

        const rows = series.value
            .map((entry) => ({
                name: entry.name,
                color: entry.color,
                value: bar.byName.get(entry.name) ?? 0,
            }))
            .filter((row) => row.value > 0);

        return { bar, rows, label: labelOf(bar.key) };
    });

    function formatValue(value: number): string {
        if (metric.value === 'cost') return formatCostCompact(value * 1_000_000);
        if (metric.value === 'requests') return formatInt(Math.round(value));
        return formatTokensCompact(Math.round(value));
    }

    /** 提示框跟着柱子走，但不让它越出容器 */
    const tooltipStyle = computed(() => {
        const bar = hovered.value?.bar;
        if (!bar) return {};
        const centerRatio = (bar.x + bar.width / 2) / VIEW_WIDTH;
        return { left: `${Math.min(72, Math.max(0, centerRatio * 100))}%` };
    });
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
                    :key="option.value"
                    type="button"
                    :class="[
                        'rounded-[10px] px-2.5 py-1 text-[11px] transition-colors',
                        metric === option.value
                            ? 'bg-[#e9e9e7] text-neutral-950'
                            : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                    ]"
                    :aria-pressed="metric === option.value"
                    @click="metric = option.value"
                >
                    {{ t(`settings.usage.trend.metric.${option.labelKey}`) }}
                </button>
            </div>
        </div>

        <div class="rounded-[11px] bg-neutral-50/80 p-4">
            <div v-if="points.length === 0" class="flex h-[140px] items-center justify-center">
                <span class="text-xs text-neutral-400">{{ t('settings.usage.trend.empty') }}</span>
            </div>

            <div v-else class="relative">
                <svg
                    :viewBox="`0 0 ${VIEW_WIDTH} ${height}`"
                    :height="height"
                    class="w-full"
                    role="img"
                    :aria-label="t('settings.usage.chart.title')"
                >
                    <template v-for="tick in yTicks" :key="tick.label">
                        <line
                            :x1="PADDING.left"
                            :x2="VIEW_WIDTH - PADDING.right"
                            :y1="tick.y"
                            :y2="tick.y"
                            stroke="currentColor"
                            class="text-neutral-100"
                            stroke-width="1"
                        />
                        <text
                            :x="PADDING.left - 6"
                            :y="tick.y + 3"
                            text-anchor="end"
                            class="fill-neutral-400"
                            font-size="9"
                        >
                            {{ tick.label }}
                        </text>
                    </template>

                    <g v-for="bar in geometry" :key="bar.key">
                        <rect
                            v-for="segment in stackOf(bar)"
                            :key="`${bar.key}-${segment.name}`"
                            :x="bar.x"
                            :y="segment.y"
                            :width="bar.width"
                            :height="Math.max(0, segment.height)"
                            :fill="segment.color"
                            :opacity="
                                hoveredIndex === null || hoveredIndex === bar.index ? 1 : 0.45
                            "
                        />
                        <!-- 命中区覆盖整列，鼠标不用精确落在柱子上 -->
                        <rect
                            :x="bar.x - (bar.slot - bar.width) / 2"
                            :y="PADDING.top"
                            :width="bar.slot"
                            :height="innerHeight"
                            fill="transparent"
                            @mouseenter="hoveredIndex = bar.index"
                            @mouseleave="hoveredIndex = null"
                        />
                    </g>

                    <text
                        v-for="index in labelIndices"
                        :key="`label-${index}`"
                        :x="geometry[index] ? geometry[index]!.x + geometry[index]!.width / 2 : 0"
                        :y="height - 5"
                        text-anchor="middle"
                        class="fill-neutral-400"
                        font-size="9"
                    >
                        {{ labelOf(geometry[index]!.key) }}
                    </text>
                </svg>

                <div
                    v-if="hovered"
                    class="pointer-events-none absolute top-0 min-w-40 rounded-[10px] border border-neutral-200 bg-white px-3 py-2 text-xs shadow-sm"
                    :style="tooltipStyle"
                    data-testid="settings-usage-chart-tooltip"
                >
                    <div class="mb-1 flex items-baseline justify-between gap-3">
                        <span class="font-medium text-neutral-900">{{ hovered.label }}</span>
                        <span class="text-neutral-500 tabular-nums">
                            {{ formatValue(hovered.bar.total) }}
                        </span>
                    </div>
                    <div class="space-y-0.5">
                        <div
                            v-for="row in hovered.rows"
                            :key="row.name"
                            class="flex items-center gap-2"
                        >
                            <span
                                class="h-2 w-2 shrink-0 rounded-sm"
                                :style="{ backgroundColor: row.color }"
                                aria-hidden="true"
                            />
                            <span
                                class="min-w-0 flex-1 truncate text-neutral-600"
                                :title="row.name"
                            >
                                {{ row.name }}
                            </span>
                            <span class="shrink-0 text-neutral-800 tabular-nums">
                                {{ formatValue(row.value) }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 图例：居中横排，只承担图例职责（总量与占比看趋势图即可） -->
            <div
                v-if="series.length > 0"
                class="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 border-t border-neutral-200/70 pt-3"
            >
                <span
                    v-for="entry in series"
                    :key="entry.name"
                    class="flex items-center gap-1.5 text-[11px] text-neutral-600"
                    :title="`${entry.name} ${formatValue(seriesTotals.get(entry.name) ?? 0)}`"
                >
                    <span
                        class="h-2 w-2 shrink-0 rounded-full"
                        :style="{ backgroundColor: entry.color }"
                        aria-hidden="true"
                    />
                    <span class="max-w-40 truncate">{{ entry.name }}</span>
                </span>
            </div>
        </div>
    </section>
</template>
