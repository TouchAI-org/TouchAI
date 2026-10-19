<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageSummary, UsageTrendPoint } from '@database/queries/usageStats';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';

    import {
        formatCost,
        formatDuration,
        formatPercent,
        formatTokensCompact,
    } from '../utils/format';

    interface Props {
        summary: UsageSummary;
        trend: { bucket: 'hour' | 'day'; points: UsageTrendPoint[] };
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageOverview' });

    type TrendMetric = 'tokens' | 'requests' | 'cost';

    const metric = ref<TrendMetric>('tokens');

    const METRIC_OPTIONS: Array<{ value: TrendMetric; labelKey: 'tokens' | 'requests' | 'cost' }> =
        [
            { value: 'tokens', labelKey: 'tokens' },
            { value: 'requests', labelKey: 'requests' },
            { value: 'cost', labelKey: 'cost' },
        ];

    /** 首屏四个核心指标 */
    const primaryCards = computed(() => [
        {
            key: 'cost',
            label: t('settings.usage.metric.cost'),
            value: formatCost(props.summary.totalCostMicros),
            /** 有未定价调用时加 ≥ 前缀，绝不把未知当 0 */
            prefix: props.summary.unpricedCount > 0 ? '≥ ' : '',
            note:
                props.summary.unpricedCount > 0
                    ? t('settings.usage.metric.unpriced', { count: props.summary.unpricedCount })
                    : t('settings.usage.metric.costNote'),
            warn: props.summary.unpricedCount > 0,
        },
        {
            key: 'requests',
            label: t('settings.usage.metric.requests'),
            value: String(props.summary.requestCount),
            prefix: '',
            note: t('settings.usage.metric.requestsNote', {
                rate: formatPercent(props.summary.successRate),
            }),
            warn: false,
        },
        {
            key: 'tokens',
            label: t('settings.usage.metric.realTokens'),
            value: formatTokensCompact(props.summary.realTotalTokens),
            prefix: '',
            note: t('settings.usage.metric.realTokensNote'),
            warn: false,
        },
        {
            key: 'ttft',
            label: t('settings.usage.metric.ttft'),
            value: formatDuration(props.summary.meanTtftMs),
            prefix: '',
            note: t('settings.usage.metric.ttftNote'),
            warn: false,
        },
    ]);

    /**
     * 次级指标。推理 token 只在真的有值时出现：
     * 恒为 0 的指标是噪音，占位置还让人以为坏了。
     */
    const secondaryMetrics = computed(() => {
        const items = [
            {
                key: 'input',
                label: t('settings.usage.metric.freshInput'),
                value: formatTokensCompact(props.summary.inputTokens),
            },
            {
                key: 'output',
                label: t('settings.usage.metric.output'),
                value: formatTokensCompact(props.summary.outputTokens),
            },
            {
                key: 'cacheRead',
                label: t('settings.usage.metric.cacheRead'),
                value: formatTokensCompact(props.summary.cacheReadTokens),
            },
            {
                key: 'cacheWrite',
                label: t('settings.usage.metric.cacheWrite'),
                value: formatTokensCompact(props.summary.cacheWriteTokens),
            },
            {
                key: 'cacheRate',
                label: t('settings.usage.metric.cacheHitRate'),
                value: formatPercent(props.summary.cacheHitRate),
            },
        ];

        if (props.summary.reasoningTokens > 0) {
            items.splice(2, 0, {
                key: 'reasoning',
                label: t('settings.usage.metric.reasoning'),
                value: formatTokensCompact(props.summary.reasoningTokens),
            });
        }

        return items;
    });

    // ===== 趋势图几何 =====

    const PADDING = { top: 8, right: 6, bottom: 18, left: 40 };
    const viewWidth = 640;
    const height = 108;
    const innerWidth = viewWidth - PADDING.left - PADDING.right;
    const innerHeight = height - PADDING.top - PADDING.bottom;

    function valueOf(point: UsageTrendPoint): number {
        if (metric.value === 'requests') return point.requests;
        if (metric.value === 'cost') return point.costMicros / 1_000_000;
        return point.tokens;
    }

    const series = computed(() =>
        props.trend.points.map((point, index) => ({ index, key: point.key, value: valueOf(point) }))
    );

    const maxValue = computed(() => Math.max(1, ...series.value.map((item) => item.value)));

    const geometry = computed(() => {
        const items = series.value;
        if (items.length === 0) return [];
        const step = items.length === 1 ? 0 : innerWidth / (items.length - 1);
        return items.map((item, index) => ({
            ...item,
            x: PADDING.left + (items.length === 1 ? innerWidth / 2 : index * step),
            y: PADDING.top + innerHeight - (item.value / maxValue.value) * innerHeight,
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
        const baseline = PADDING.top + innerHeight;
        return `${linePath.value} L${last.x.toFixed(1)},${baseline} L${first.x.toFixed(1)},${baseline} Z`;
    });

    const labelIndices = computed(() => {
        const total = geometry.value.length;
        if (total === 0) return [];
        const step = total <= 6 ? 1 : Math.ceil(total / 5);
        return geometry.value.filter((_, index) => index % step === 0).map((point) => point.index);
    });

    const yTicks = computed(() =>
        [0, 1].map((ratio) => ({
            y: PADDING.top + innerHeight * (1 - ratio),
            label:
                metric.value === 'cost'
                    ? `$${(maxValue.value * ratio).toFixed(2)}`
                    : metric.value === 'requests'
                      ? String(Math.round(maxValue.value * ratio))
                      : formatTokensCompact(Math.round(maxValue.value * ratio)),
        }))
    );

    function labelOf(key: string): string {
        return props.trend.bucket === 'hour' ? key.slice(11, 16) : key.slice(5).replace('-', '/');
    }
</script>

<template>
    <section class="space-y-3">
        <div class="settings-row-group p-4">
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div
                    v-for="card in primaryCards"
                    :key="card.key"
                    class="flex min-w-0 flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3"
                >
                    <span class="truncate text-xs text-neutral-500">{{ card.label }}</span>
                    <span
                        class="truncate font-serif text-[22px] leading-tight font-semibold text-neutral-950 tabular-nums"
                        :title="`${card.prefix}${card.value}`"
                    >
                        {{ card.prefix }}{{ card.value }}
                    </span>
                    <span
                        class="truncate text-[11px]"
                        :class="card.warn ? 'text-amber-600' : 'text-neutral-400'"
                    >
                        {{ card.note }}
                    </span>
                </div>
            </div>

            <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 lg:grid-cols-3">
                <div
                    v-for="item in secondaryMetrics"
                    :key="item.key"
                    class="flex items-baseline justify-between gap-2 text-xs"
                >
                    <span class="min-w-0 truncate text-neutral-500">{{ item.label }}</span>
                    <span class="shrink-0 text-neutral-800 tabular-nums" :title="item.value">
                        {{ item.value }}
                    </span>
                </div>
            </div>
        </div>

        <!-- 趋势与指标同屏：不再单独占一段 -->
        <div class="settings-row-group p-4">
            <div class="mb-2 flex items-center justify-between gap-3">
                <span class="text-[13px] text-neutral-950">
                    {{ t('settings.usage.trend.title') }}
                </span>
                <div class="flex items-center gap-1">
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

            <div v-if="trend.points.length === 0" class="flex h-[88px] items-center justify-center">
                <span class="text-xs text-neutral-400">{{ t('settings.usage.trend.empty') }}</span>
            </div>

            <svg
                v-else
                :viewBox="`0 0 ${viewWidth} ${height}`"
                :height="height"
                class="w-full"
                role="img"
                :aria-label="t('settings.usage.trend.title')"
            >
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

                <path :d="areaPath" fill="currentColor" class="text-neutral-900/5" />
                <path
                    :d="linePath"
                    fill="none"
                    stroke="currentColor"
                    class="text-neutral-800"
                    stroke-width="1.5"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                />

                <text
                    v-for="index in labelIndices"
                    :key="`label-${index}`"
                    :x="geometry[index]?.x ?? 0"
                    :y="height - 4"
                    text-anchor="middle"
                    class="fill-neutral-400"
                    font-size="9"
                >
                    {{ labelOf(geometry[index]?.key ?? '') }}
                </text>
            </svg>
        </div>
    </section>
</template>
