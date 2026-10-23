<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import DonutChart from '@components/ui/donut-chart/DonutChart.vue';
    import type { ToolUsageSummary } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { formatDuration, formatInt, formatPercent } from '../utils/format';

    interface Props {
        stats: ToolUsageSummary;
        /** The component draws its own skeleton while data is missing. */
        loading?: boolean;
    }

    const props = defineProps<Props>();
    defineOptions({ name: 'UsageToolStats' });

    /** List the top few tools; the rest fold into "other" so the page stays readable. */
    const MAX_SEGMENTS = 5;

    /** Shared palette with the trend chart and the composition rings. */
    const SERIES = [
        'rgb(63 63 70)',
        'rgb(14 165 233)',
        'rgb(16 185 129)',
        'rgb(245 158 11)',
        'rgb(139 92 246)',
    ];
    const OTHER_COLOR = 'rgb(212 212 212)';

    /** Strip the prefix for readability; the full name stays in the title. */
    function displayName(name: string): string {
        if (name.startsWith('builtin__')) return name.slice('builtin__'.length);
        const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
        if (mcp) return mcp[2]!;
        return name;
    }

    /**
     * Group once here so both rings share the same keys.
     *
     * If each ring grouped by its own share, the top tool by duration could
     * differ from the top tool by calls and the two legends would not line up
     * for comparison.
     */
    const ranked = computed(() =>
        [...props.stats.byTool].sort((left, right) => right.count - left.count)
    );

    const shown = computed(() => ranked.value.slice(0, MAX_SEGMENTS));
    const hidden = computed(() => ranked.value.slice(MAX_SEGMENTS));
    const hasOther = computed(() => hidden.value.length > 0);

    /** One fixed colour per tool, identical across both rings. */
    const colorOf = computed(() => {
        const map = new Map<string, string>();
        shown.value.forEach((tool, index) => {
            map.set(tool.name, SERIES[index % SERIES.length]!);
        });
        map.set('__other', OTHER_COLOR);
        return map;
    });

    /** Total time for one tool: mean duration x call count. */
    function totalMsOf(mean: number | null, count: number): number {
        return mean === null ? 0 : mean * count;
    }

    /** Ring data by call count. */
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

    /** Ring data by total tool time. */
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
                两张卡内部已经铺满内容，间距要比普通栅格大一些才不会读成一块。
            -->
            <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
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
