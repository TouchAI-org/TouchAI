<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { ToolUsageSummary } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { formatDuration, formatInt, formatPercent } from '../utils/format';

    interface Props {
        stats: ToolUsageSummary;
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageToolStats' });

    /** 只列前若干名，其余折进「其他」，避免长列表淹没页面 */
    const MAX_ROWS = 8;

    const rows = computed(() => props.stats.byTool.slice(0, MAX_ROWS));

    const hiddenCount = computed(() => Math.max(0, props.stats.byTool.length - MAX_ROWS));

    /** 分母是调用总数，与卡片里的数字口径一致 */
    function shareOf(count: number): number {
        return props.stats.totalCount > 0 ? count / props.stats.totalCount : 0;
    }

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

    function kindLabel(kind: 'builtin' | 'mcp'): string {
        return kind === 'mcp' ? t('settings.usage.tools.mcp') : t('settings.usage.tools.builtin');
    }
</script>

<template>
    <section class="space-y-4" data-testid="settings-usage-tools">
        <div>
            <h2 class="settings-section-title">{{ t('settings.usage.tools.title') }}</h2>
            <p class="settings-section-description">
                {{ t('settings.usage.tools.description') }}
            </p>
        </div>

        <div v-if="stats.totalCount === 0" class="settings-row-group px-5 py-10 text-center">
            <span class="text-xs text-neutral-400">{{ t('settings.usage.tools.empty') }}</span>
        </div>

        <template v-else>
            <div class="settings-row-group p-4">
                <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <div class="flex flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3">
                        <span class="text-xs text-neutral-500">
                            {{ t('settings.usage.tools.total') }}
                        </span>
                        <span
                            class="font-serif text-[22px] leading-tight font-semibold text-neutral-950 tabular-nums"
                        >
                            {{ formatInt(stats.totalCount) }}
                        </span>
                    </div>
                    <div class="flex flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3">
                        <span class="text-xs text-neutral-500">
                            {{ t('settings.usage.tools.distinct') }}
                        </span>
                        <span
                            class="font-serif text-[22px] leading-tight font-semibold text-neutral-950 tabular-nums"
                        >
                            {{ formatInt(stats.distinctTools) }}
                        </span>
                    </div>
                    <div class="flex flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3">
                        <span class="text-xs text-neutral-500">
                            {{ t('settings.usage.tools.errorRate') }}
                        </span>
                        <span
                            :class="[
                                'font-serif text-[22px] leading-tight font-semibold tabular-nums',
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
                    <div class="flex flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3">
                        <span class="text-xs text-neutral-500">
                            {{ t('settings.usage.tools.meanDuration') }}
                        </span>
                        <span
                            class="font-serif text-[22px] leading-tight font-semibold text-neutral-950 tabular-nums"
                        >
                            {{ formatDuration(stats.meanDurationMs) }}
                        </span>
                    </div>
                </div>
            </div>

            <div class="settings-row-group divide-y divide-neutral-200/70">
                <div
                    class="flex items-center gap-4 px-5 py-2 text-[11px] text-neutral-400"
                    aria-hidden="true"
                >
                    <span class="min-w-0 flex-1">{{ t('settings.usage.tools.column.tool') }}</span>
                    <span class="w-16 shrink-0 text-right">
                        {{ t('settings.usage.tools.column.calls') }}
                    </span>
                    <span class="w-14 shrink-0 text-right">
                        {{ t('settings.usage.tools.column.share') }}
                    </span>
                    <span class="w-16 shrink-0 text-right">
                        {{ t('settings.usage.tools.column.errorRate') }}
                    </span>
                    <span class="w-16 shrink-0 text-right">
                        {{ t('settings.usage.tools.column.duration') }}
                    </span>
                </div>

                <div
                    v-for="row in rows"
                    :key="row.name"
                    data-testid="settings-usage-tool-row"
                    class="flex items-center gap-4 px-5 py-2.5 transition-colors hover:bg-[#f1f1ef]"
                >
                    <div class="flex min-w-0 flex-1 items-center gap-2">
                        <span class="truncate text-[13px] text-neutral-950" :title="row.name">
                            {{ displayName(row.name) }}
                        </span>
                        <span
                            class="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500"
                        >
                            {{ kindLabel(row.kind) }}
                        </span>
                    </div>
                    <span
                        class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ formatInt(row.count) }}
                    </span>
                    <span
                        class="w-14 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ formatPercent(shareOf(row.count)) }}
                    </span>
                    <span
                        :class="[
                            'w-16 shrink-0 text-right text-[13px] tabular-nums',
                            row.errorCount > 0 ? 'text-red-600' : 'text-neutral-600',
                        ]"
                    >
                        {{ formatPercent(errorRateOf(row.count, row.errorCount)) }}
                    </span>
                    <span
                        class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ formatDuration(row.meanDurationMs) }}
                    </span>
                </div>

                <p
                    v-if="hiddenCount > 0"
                    class="px-5 py-2 text-[11px] text-neutral-400"
                    data-testid="settings-usage-tools-more"
                >
                    {{ t('settings.usage.tools.more', { count: hiddenCount }) }}
                </p>
            </div>
        </template>
    </section>
</template>
