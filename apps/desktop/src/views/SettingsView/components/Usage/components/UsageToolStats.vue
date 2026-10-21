<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import DonutChart from '@components/ui/donut-chart/DonutChart.vue';
    import type { ToolUsageSummary } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { formatDuration, formatInt, formatPercent } from '../utils/format';

    interface Props {
        stats: ToolUsageSummary;
        /** 数据未到时在组件内部画骨架，不再由外部统一拼接 */
        loading?: boolean;
    }

    const props = defineProps<Props>();
    defineOptions({ name: 'UsageToolStats' });

    /** 只列前若干名，其余折进「其他」，避免长列表淹没页面 */
    const MAX_SEGMENTS = 5;

    /** 与趋势图、构成环共用同一套色板 */
    const SERIES = [
        'rgb(63 63 70)',
        'rgb(14 165 233)',
        'rgb(16 185 129)',
        'rgb(245 158 11)',
        'rgb(139 92 246)',
    ];
    const OTHER_COLOR = 'rgb(212 212 212)';

    /** 工具名去掉前缀后更易读；前缀本身保留在 title 里 */
    function displayName(name: string): string {
        if (name.startsWith('builtin__')) return name.slice('builtin__'.length);
        const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
        if (mcp) return mcp[2]!;
        return name;
    }

    /**
     * 分组在组件里做一次，两张环图共用同一批 key。
     *
     * 如果各自按占比分组，右侧「耗时」的第一名可能和左侧「次数」不同，
     * 两张图的图例就会对不上，读者无法横向比较。
     */
    const ranked = computed(() =>
        [...props.stats.byTool].sort((left, right) => right.count - left.count)
    );

    const shown = computed(() => ranked.value.slice(0, MAX_SEGMENTS));
    const hidden = computed(() => ranked.value.slice(MAX_SEGMENTS));
    const hasOther = computed(() => hidden.value.length > 0);

    /** 每个工具一个固定颜色，两张环图一致 */
    const colorOf = computed(() => {
        const map = new Map<string, string>();
        shown.value.forEach((tool, index) => {
            map.set(tool.name, SERIES[index % SERIES.length]!);
        });
        map.set('__other', OTHER_COLOR);
        return map;
    });

    /** 单个工具的总耗时：平均耗时 × 调用次数 */
    function totalMsOf(mean: number | null, count: number): number {
        return mean === null ? 0 : mean * count;
    }

    /** 环图数据：按调用次数 */
    const callData = computed(() => {
        const slices = shown.value.map((tool) => ({
            key: tool.name,
            label: displayName(tool.name),
            value: tool.count,
            color: colorOf.value.get(tool.name),
        }));
        if (hasOther.value) {
            slices.push({
                key: '__other',
                label: t('settings.usage.chart.other'),
                value: hidden.value.reduce((sum, tool) => sum + tool.count, 0),
                color: OTHER_COLOR,
            });
        }
        return slices;
    });

    /** 环图数据：按工具耗时汇总 */
    const timeData = computed(() => {
        const slices = shown.value.map((tool) => ({
            key: tool.name,
            label: displayName(tool.name),
            value: totalMsOf(tool.meanDurationMs, tool.count),
            color: colorOf.value.get(tool.name),
        }));
        if (hasOther.value) {
            slices.push({
                key: '__other',
                label: t('settings.usage.chart.other'),
                value: hidden.value.reduce(
                    (sum, tool) => sum + totalMsOf(tool.meanDurationMs, tool.count),
                    0
                ),
                color: OTHER_COLOR,
            });
        }
        return slices;
    });
</script>

<template>
    <section class="space-y-3" data-testid="settings-usage-tools">
        <div>
            <h2 class="settings-section-title">{{ t('settings.usage.tools.title') }}</h2>
            <p class="settings-section-description">
                {{ t('settings.usage.tools.description') }}
            </p>
        </div>

        <div
            v-if="loading"
            class="space-y-3"
            data-testid="settings-usage-tools-loading"
            aria-hidden="true"
        >
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div
                    v-for="index in 4"
                    :key="index"
                    class="flex flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3"
                >
                    <div class="h-3 w-14 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-5 w-16 animate-pulse rounded bg-neutral-200/70" />
                </div>
            </div>
            <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <div v-for="index in 2" :key="index" class="rounded-[11px] bg-neutral-50/80 p-4">
                    <div class="flex items-center gap-6">
                        <div
                            class="h-40 w-40 shrink-0 animate-pulse rounded-full bg-neutral-200/60"
                        />
                        <div class="flex-1 space-y-2">
                            <div
                                v-for="line in 4"
                                :key="line"
                                class="h-3 animate-pulse rounded bg-neutral-200/60"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div
            v-else-if="stats.totalCount === 0"
            class="rounded-[11px] bg-neutral-50/80 px-5 py-10 text-center"
        >
            <span class="text-xs text-neutral-400">{{ t('settings.usage.tools.empty') }}</span>
        </div>

        <template v-else>
            <!-- 指标：与首屏同样的独立浅底小卡，不套大卡壳 -->
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div class="flex flex-col gap-0.5 rounded-[10px] bg-neutral-50/80 px-4 py-3">
                    <span class="text-[11px] text-neutral-500">
                        {{ t('settings.usage.tools.total') }}
                    </span>
                    <span
                        class="font-serif text-[20px] leading-tight font-semibold text-neutral-950 tabular-nums"
                    >
                        {{ formatInt(stats.totalCount) }}
                    </span>
                </div>
                <div class="flex flex-col gap-0.5 rounded-[10px] bg-neutral-50/80 px-4 py-3">
                    <span class="text-[11px] text-neutral-500">
                        {{ t('settings.usage.tools.distinct') }}
                    </span>
                    <span
                        class="font-serif text-[20px] leading-tight font-semibold text-neutral-950 tabular-nums"
                    >
                        {{ formatInt(stats.distinctTools) }}
                    </span>
                </div>
                <div class="flex flex-col gap-0.5 rounded-[10px] bg-neutral-50/80 px-4 py-3">
                    <span class="text-[11px] text-neutral-500">
                        {{ t('settings.usage.tools.errorRate') }}
                    </span>
                    <span
                        :class="[
                            'font-serif text-[20px] leading-tight font-semibold tabular-nums',
                            stats.errorCount > 0 ? 'text-red-600' : 'text-neutral-950',
                        ]"
                    >
                        {{
                            formatPercent(
                                stats.totalCount > 0 ? stats.errorCount / stats.totalCount : 0
                            )
                        }}
                    </span>
                </div>
                <div class="flex flex-col gap-0.5 rounded-[10px] bg-neutral-50/80 px-4 py-3">
                    <span class="text-[11px] text-neutral-500">
                        {{ t('settings.usage.tools.meanDuration') }}
                    </span>
                    <span
                        class="font-serif text-[20px] leading-tight font-semibold text-neutral-950 tabular-nums"
                    >
                        {{ formatDuration(stats.meanDurationMs) }}
                    </span>
                </div>
            </div>

            <!--
                两张环图并排，与上方 Token / 耗时构成同一套版式：
                环图在左、图例在右，颜色按工具固定，左右两侧可以横向对照。
            -->
            <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <section class="space-y-3">
                    <h3 class="settings-section-title">
                        {{ t('settings.usage.tools.callsTitle') }}
                    </h3>
                    <div class="rounded-[11px] bg-neutral-50/80 p-4">
                        <DonutChart
                            :data="callData"
                            :total-label="t('settings.usage.tools.total')"
                            :size="176"
                            :thickness="22"
                            :format-value="formatInt"
                        />
                    </div>
                </section>

                <section class="space-y-3">
                    <h3 class="settings-section-title">
                        {{ t('settings.usage.tools.timeTitle') }}
                    </h3>
                    <div class="rounded-[11px] bg-neutral-50/80 p-4">
                        <DonutChart
                            :data="timeData"
                            :total-label="t('settings.usage.tools.timeTotal')"
                            :size="176"
                            :thickness="22"
                            :format-value="formatDuration"
                        />
                    </div>
                </section>
            </div>

            <p v-if="hasOther" class="text-[11px] text-neutral-400">
                {{ t('settings.usage.tools.more', { count: hidden.length }) }}
            </p>
        </template>
    </section>
</template>
