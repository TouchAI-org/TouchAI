<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageTrendPoint } from '@database/queries/usageStats';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';

    import { formatCost, formatDayLabel, formatInt, formatTokensCompact } from '../utils/format';

    type TrendMetric = 'tokens' | 'requests' | 'cost';

    interface Props {
        points: UsageTrendPoint[];
        bucket: 'hour' | 'day';
        compact: boolean;
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageTrendChart' });

    const metric = ref<TrendMetric>('tokens');
    const hoveredIndex = ref<number | null>(null);

    const METRIC_OPTIONS: Array<{ value: TrendMetric; labelKey: 'tokens' | 'requests' | 'cost' }> =
        [
            { value: 'tokens', labelKey: 'tokens' },
            { value: 'requests', labelKey: 'requests' },
            { value: 'cost', labelKey: 'cost' },
        ];

    const PADDING = { top: 10, right: 8, bottom: 22, left: 44 };
    const height = computed(() => (props.compact ? 140 : 190));

    const viewWidth = 720;
    const innerWidth = viewWidth - PADDING.left - PADDING.right;
    const innerHeight = computed(() => height.value - PADDING.top - PADDING.bottom);

    function valueOf(point: UsageTrendPoint): number {
        if (metric.value === 'requests') return point.requests;
        if (metric.value === 'cost') return point.costMicros / 1_000_000;
        return point.tokens;
    }

    const series = computed(() =>
        props.points.map((point, index) => ({ index, key: point.key, value: valueOf(point) }))
    );

    const maxValue = computed(() => Math.max(1, ...series.value.map((item) => item.value)));

    const geometry = computed(() => {
        const items = series.value;
        if (items.length === 0) return [];
        const step = items.length === 1 ? 0 : innerWidth / (items.length - 1);
        return items.map((item, index) => ({
            ...item,
            x: PADDING.left + (items.length === 1 ? innerWidth / 2 : index * step),
            y: PADDING.top + innerHeight.value - (item.value / maxValue.value) * innerHeight.value,
        }));
    });

    const linePath = computed(() =>
        geometry.value
            .map(
                (point, index) =>
                    `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
            )
            .join(' ')
    );

    const areaPath = computed(() => {
        const points = geometry.value;
        if (points.length === 0) return '';
        const first = points[0]!;
        const last = points[points.length - 1]!;
        const baseline = PADDING.top + innerHeight.value;
        return `${linePath.value} L${last.x.toFixed(1)},${baseline} L${first.x.toFixed(1)},${baseline} Z`;
    });

    /** X 轴标签自动稀疏：点少全显，点多按档位抽取 */
    const labelIndices = computed(() => {
        const total = geometry.value.length;
        if (total === 0) return [];
        const step = total <= 8 ? 1 : total <= 31 ? Math.ceil(total / 6) : Math.ceil(total / 5);
        const indices = geometry.value.filter((_, index) => index % step === 0).map((p) => p.index);
        // 最后一个若与倒数第二个过近则省略
        if (indices.length > 1) {
            const last = indices[indices.length - 1]!;
            const previous = indices[indices.length - 2]!;
            if (last - previous < step / 2) indices.pop();
        }
        return indices;
    });

    const yTicks = computed(() => {
        const ticks = [0, 0.5, 1];
        return ticks.map((ratio) => ({
            y: PADDING.top + innerHeight.value * (1 - ratio),
            label:
                metric.value === 'cost'
                    ? `$${(maxValue.value * ratio).toFixed(2)}`
                    : metric.value === 'requests'
                      ? formatInt(Math.round(maxValue.value * ratio))
                      : formatTokensCompact(Math.round(maxValue.value * ratio)),
        }));
    });

    function labelOf(key: string): string {
        if (props.bucket === 'hour') {
            return key.slice(11, 16);
        }
        return formatDayLabel(key);
    }

    function valueText(point: UsageTrendPoint): string {
        if (metric.value === 'cost') return formatCost(point.costMicros);
        if (metric.value === 'requests') return formatInt(point.requests);
        return formatTokensCompact(point.tokens);
    }

    const hoveredPoint = computed(() => {
        const index = hoveredIndex.value;
        if (index === null) return null;
        const geo = geometry.value[index];
        const data = props.points[index];
        if (!geo || !data) return null;
        return { geo, data };
    });
</script>

<template>
    <section class="flex flex-col gap-2 rounded-[13px] border border-neutral-200/70 bg-white p-3">
        <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium tracking-wide text-neutral-500">
                {{ t('settings.usage.trend.title') }}
            </span>
            <div class="flex items-center gap-0.5 rounded-[8px] bg-neutral-100 p-[3px]">
                <button
                    v-for="option in METRIC_OPTIONS"
                    :key="option.value"
                    type="button"
                    :class="[
                        'rounded-[6px] px-2.5 py-1 text-[11px] transition-colors',
                        metric === option.value
                            ? 'bg-white font-semibold text-neutral-900 shadow-sm'
                            : 'text-neutral-500 hover:text-neutral-800',
                    ]"
                    :aria-pressed="metric === option.value"
                    @click="metric = option.value"
                >
                    {{ t(`settings.usage.trend.metric.${option.labelKey}`) }}
                </button>
            </div>
        </div>

        <div v-if="points.length === 0" class="flex h-[120px] items-center justify-center">
            <span class="text-xs text-neutral-400">{{ t('settings.usage.trend.empty') }}</span>
        </div>

        <div v-else class="relative">
            <svg
                :viewBox="`0 0 ${viewWidth} ${height}`"
                :height="height"
                class="w-full"
                role="img"
                :aria-label="t('settings.usage.trend.title')"
            >
                <!-- Y 轴刻度与网格 -->
                <g>
                    <template v-for="tick in yTicks" :key="tick.label">
                        <line
                            :x1="PADDING.left"
                            :x2="viewWidth - PADDING.right"
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
                </g>

                <!-- 面积与折线 -->
                <path :d="areaPath" fill="currentColor" class="text-neutral-900/5" />
                <path
                    :d="linePath"
                    fill="none"
                    stroke="currentColor"
                    class="text-neutral-800"
                    stroke-width="1.6"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                />

                <!-- hover 命中区 -->
                <rect
                    v-for="point in geometry"
                    :key="`hit-${point.index}`"
                    :x="
                        point.x -
                        (geometry.length > 1 ? innerWidth / geometry.length / 2 : innerWidth / 2)
                    "
                    :y="PADDING.top"
                    :width="geometry.length > 1 ? innerWidth / geometry.length : innerWidth"
                    :height="innerHeight"
                    fill="transparent"
                    @mouseenter="hoveredIndex = point.index"
                    @mouseleave="hoveredIndex = null"
                />

                <!-- hover 标记点 -->
                <circle
                    v-if="hoveredPoint"
                    :cx="hoveredPoint.geo.x"
                    :cy="hoveredPoint.geo.y"
                    r="3"
                    fill="currentColor"
                    class="text-neutral-900"
                />

                <!-- X 轴标签 -->
                <text
                    v-for="index in labelIndices"
                    :key="`label-${index}`"
                    :x="geometry[index]?.x ?? 0"
                    :y="height - 6"
                    text-anchor="middle"
                    class="fill-neutral-400"
                    font-size="9"
                >
                    {{ labelOf(geometry[index]?.key ?? '') }}
                </text>
            </svg>

            <div
                v-if="hoveredPoint"
                class="pointer-events-none absolute top-0 rounded-[8px] border border-neutral-200 bg-white px-2.5 py-1.5 text-[11px] whitespace-nowrap shadow-sm"
                :style="{
                    left: `${Math.min(78, (hoveredPoint.geo.x / viewWidth) * 100)}%`,
                }"
            >
                <div class="font-medium text-neutral-800">
                    {{ labelOf(hoveredPoint.data.key) }}
                </div>
                <div class="text-neutral-500 tabular-nums">
                    {{ valueText(hoveredPoint.data) }}
                </div>
            </div>
        </div>
    </section>
</template>
