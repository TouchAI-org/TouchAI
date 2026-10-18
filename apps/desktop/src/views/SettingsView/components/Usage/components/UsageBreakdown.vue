<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageGroup } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import {
        formatCost,
        formatDuration,
        formatInt,
        formatPercent,
        formatTokensCompact,
    } from '../utils/format';

    interface Props {
        title: string;
        groups: UsageGroup[];
        /** 已选中的分组 id；用于高亮与再次点击取消 */
        selectedId: number | null;
        /** 首列标题，例如「模型」「供应商」 */
        nameLabel: string;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{ (event: 'select', id: number | null): void }>();

    defineOptions({ name: 'UsageBreakdown' });

    const totalTokens = computed(() =>
        props.groups.reduce(
            (sum, group) =>
                sum +
                group.inputTokens +
                group.outputTokens +
                group.cacheReadTokens +
                group.cacheWriteTokens,
            0
        )
    );

    function share(group: UsageGroup): number {
        const tokens =
            group.inputTokens + group.outputTokens + group.cacheReadTokens + group.cacheWriteTokens;
        return totalTokens.value > 0 ? tokens / totalTokens.value : 0;
    }

    function cacheRate(group: UsageGroup): number {
        const denominator = group.inputTokens + group.cacheWriteTokens + group.cacheReadTokens;
        return denominator > 0 ? group.cacheReadTokens / denominator : 0;
    }

    function tokensOf(group: UsageGroup): number {
        return (
            group.inputTokens + group.outputTokens + group.cacheReadTokens + group.cacheWriteTokens
        );
    }

    function handleSelect(group: UsageGroup) {
        if (group.id === null) {
            return;
        }

        emit('select', props.selectedId === group.id ? null : group.id);
    }
</script>

<template>
    <section class="space-y-4">
        <h2 class="settings-section-title">{{ title }}</h2>

        <div v-if="groups.length === 0" class="settings-row-group px-5 py-10 text-center">
            <span class="text-xs text-neutral-400">{{ t('settings.usage.group.empty') }}</span>
        </div>

        <div v-else class="settings-row-group divide-y divide-neutral-200/70">
            <div
                class="flex items-center gap-4 px-5 py-2 text-[11px] text-neutral-400"
                aria-hidden="true"
            >
                <span class="min-w-0 flex-1">{{ nameLabel }}</span>
                <span class="w-14 shrink-0 text-right">{{ t('settings.usage.table.calls') }}</span>
                <span class="w-16 shrink-0 text-right">{{ t('settings.usage.table.tokens') }}</span>
                <span class="w-14 shrink-0 text-right">
                    {{ t('settings.usage.table.cacheRate') }}
                </span>
                <span class="w-14 shrink-0 text-right">{{ t('settings.usage.table.ttft') }}</span>
                <span class="w-20 shrink-0 text-right">{{ t('settings.usage.table.cost') }}</span>
            </div>

            <button
                v-for="group in groups"
                :key="group.id ?? group.name"
                type="button"
                data-testid="settings-usage-breakdown-row"
                :class="[
                    'flex w-full items-center gap-4 rounded-none bg-transparent px-5 py-3 text-left transition-colors hover:bg-[#f1f1ef]',
                    selectedId === group.id ? 'bg-[#e9e9e7]' : '',
                ]"
                :aria-pressed="selectedId === group.id"
                @click="handleSelect(group)"
            >
                <div class="min-w-0 flex-1">
                    <div class="truncate text-[13px] text-neutral-950" :title="group.name">
                        {{ group.name }}
                    </div>
                    <div class="mt-1 flex items-center gap-2">
                        <div
                            class="h-[3px] w-full max-w-40 overflow-hidden rounded-full bg-neutral-100"
                        >
                            <div
                                class="h-full rounded-full bg-neutral-800/70"
                                :style="{ width: `${Math.max(2, share(group) * 100)}%` }"
                            />
                        </div>
                        <span
                            v-if="group.unpricedCount > 0"
                            class="shrink-0 text-[11px] text-amber-600"
                        >
                            {{
                                t('settings.usage.metric.unpriced', { count: group.unpricedCount })
                            }}
                        </span>
                    </div>
                </div>

                <span class="w-14 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums">
                    {{ formatInt(group.requestCount) }}
                </span>
                <span class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums">
                    {{ formatTokensCompact(tokensOf(group)) }}
                </span>
                <span class="w-14 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums">
                    {{ formatPercent(cacheRate(group)) }}
                </span>
                <span class="w-14 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums">
                    {{ formatDuration(group.meanTtftMs) }}
                </span>
                <span class="w-20 shrink-0 text-right text-[13px] text-neutral-950 tabular-nums">
                    {{ formatCost(group.totalCostMicros) }}
                </span>
            </button>
        </div>
    </section>
</template>
