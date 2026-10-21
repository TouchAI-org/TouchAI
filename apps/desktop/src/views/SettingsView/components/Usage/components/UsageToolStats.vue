<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
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
    const MAX_ROWS = 8;
    /** 环图最多展示的分类数（含「其他」） */
    const MAX_RING = 5;

    const rows = computed(() => props.stats.byTool.slice(0, MAX_ROWS));

    const hiddenCount = computed(() => Math.max(0, props.stats.byTool.length - MAX_ROWS));

    /** 分母是调用总数，与卡片里的数字口径一致 */
    function errorRateOf(count: number, errorCount: number): number {
        return count > 0 ? errorCount / count : 0;
    }

    /** 工具名去掉前缀后更易读；前缀本身保留在 title 里 */
    function displayName(name: string): string {
        if (name.startsWith('builtin__')) return name.slice('builtin__'.length);
        const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
        if (mcp) return mcp[2]!;
        return name;
    }

    /** 环形几何：与 Token/耗时构成保持一致 */
    const RING = 128;
    const R = 32;
    const STROKE = 8;
    const CIRCUMFERENCE = 2 * Math.PI * R;

    /** 与趋势图、构成环共用同一套色板 */
    const PALETTE = [
        'rgb(63 63 70)',
        'rgb(14 165 233)',
        'rgb(16 185 129)',
        'rgb(245 158 11)',
        'rgb(139 92 246)',
        'rgb(236 72 153)',
    ];
    const OTHER_COLOR = 'rgb(212 212 212)';

    /**
     * 按调用次数占比拆成环。
     *
     * 只取前 N 名，其余合并为「其他」：色板只有 6 色，再多就分不清了。
     */
    const ringSlices = computed(() => {
        const ranked = [...props.stats.byTool].sort((left, right) => right.count - left.count);
        const head = ranked.slice(0, MAX_RING);
        const tail = ranked.slice(MAX_RING);
        const total = props.stats.totalCount || 1;

        const entries = head.map((tool, index) => ({
            name: displayName(tool.name),
            value: tool.count,
            color: PALETTE[index % PALETTE.length]!,
        }));
        if (tail.length > 0) {
            entries.push({
                name: t('settings.usage.chart.other'),
                value: tail.reduce((sum, tool) => sum + tool.count, 0),
                color: OTHER_COLOR,
            });
        }

        let consumed = 0;
        return entries.map((entry) => {
            const ratio = entry.value / total;
            const length = ratio * CIRCUMFERENCE;
            const slice = {
                ...entry,
                ratio,
                dash: `${length.toFixed(2)} ${(CIRCUMFERENCE - length).toFixed(2)}`,
                offset: -consumed,
            };
            consumed += length;
            return slice;
        });
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
            <div class="rounded-[11px] bg-neutral-50/80 p-4">
                <div class="flex items-center gap-5">
                    <div class="h-28 w-28 shrink-0 animate-pulse rounded-full bg-neutral-200/60" />
                    <div class="flex-1 space-y-2">
                        <div
                            v-for="index in 4"
                            :key="index"
                            class="h-3 animate-pulse rounded bg-neutral-200/60"
                        />
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

            <!-- 环图 + 明细：与 Token/耗时构成同一套读法，明细用独立小块而不是分割线 -->
            <div
                class="flex flex-col gap-5 rounded-[11px] bg-neutral-50/80 p-4 lg:flex-row lg:items-center"
            >
                <div class="flex shrink-0 items-center gap-5">
                    <div class="relative">
                        <svg
                            :viewBox="`0 0 ${RING} ${RING}`"
                            class="h-28 w-28 -rotate-90"
                            role="img"
                            :aria-label="t('settings.usage.tools.title')"
                        >
                            <circle
                                :cx="RING / 2"
                                :cy="RING / 2"
                                :r="R"
                                fill="none"
                                stroke="currentColor"
                                class="text-neutral-200/70"
                                :stroke-width="STROKE"
                            />
                            <circle
                                v-for="slice in ringSlices"
                                :key="slice.name"
                                :cx="RING / 2"
                                :cy="RING / 2"
                                :r="R"
                                fill="none"
                                :stroke="slice.color"
                                :stroke-width="STROKE"
                                :stroke-dasharray="slice.dash"
                                :stroke-dashoffset="slice.offset"
                            />
                        </svg>
                        <div
                            class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
                        >
                            <span
                                class="max-w-[66px] truncate text-center font-serif text-[14px] leading-tight font-semibold text-neutral-950 tabular-nums"
                            >
                                {{ formatInt(stats.totalCount) }}
                            </span>
                            <span class="mt-1 text-[10px] text-neutral-400">
                                {{ t('settings.usage.tools.total') }}
                            </span>
                        </div>
                    </div>

                    <div class="min-w-0 space-y-1.5">
                        <div
                            v-for="slice in ringSlices"
                            :key="slice.name"
                            class="flex items-baseline gap-2 text-[12px]"
                        >
                            <span
                                class="h-1.5 w-1.5 shrink-0 rounded-full"
                                :style="{ backgroundColor: slice.color }"
                                aria-hidden="true"
                            />
                            <span class="min-w-0 flex-1 truncate text-neutral-700">
                                {{ slice.name }}
                            </span>
                            <span class="shrink-0 font-medium text-neutral-900 tabular-nums">
                                {{ formatPercent(slice.ratio) }}
                            </span>
                        </div>
                    </div>
                </div>

                <div class="min-w-0 flex-1 space-y-1.5">
                    <div
                        v-for="row in rows"
                        :key="row.name"
                        data-testid="settings-usage-tool-row"
                        class="flex items-center gap-3 rounded-[9px] bg-white/70 px-3 py-1.5"
                    >
                        <span
                            class="min-w-0 flex-1 truncate text-[12px] text-neutral-900"
                            :title="row.name"
                        >
                            {{ displayName(row.name) }}
                        </span>
                        <span class="shrink-0 text-[12px] text-neutral-500 tabular-nums">
                            {{ formatInt(row.count) }}
                        </span>
                        <span
                            :class="[
                                'w-14 shrink-0 text-right text-[12px] tabular-nums',
                                row.errorCount > 0 ? 'text-red-600' : 'text-neutral-500',
                            ]"
                        >
                            {{ formatPercent(errorRateOf(row.count, row.errorCount)) }}
                        </span>
                        <span
                            class="w-14 shrink-0 text-right text-[12px] text-neutral-500 tabular-nums"
                        >
                            {{ formatDuration(row.meanDurationMs) }}
                        </span>
                    </div>

                    <p
                        v-if="hiddenCount > 0"
                        class="px-3 text-[11px] text-neutral-400"
                        data-testid="settings-usage-tools-more"
                    >
                        {{ t('settings.usage.tools.more', { count: hiddenCount }) }}
                    </p>
                </div>
            </div>
        </template>
    </section>
</template>
