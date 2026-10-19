<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageGroup } from '@database/queries/usageStats';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';

    import {
        formatCost,
        formatDuration,
        formatInt,
        formatPercent,
        formatTokensCompact,
    } from '../utils/format';

    interface Props {
        byModel: UsageGroup[];
        byProvider: UsageGroup[];
        selectedModelId: number | null;
        selectedProviderId: number | null;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        (event: 'select-model', id: number | null): void;
        (event: 'select-provider', id: number | null): void;
    }>();

    defineOptions({ name: 'UsageBreakdown' });

    type Dimension = 'model' | 'provider';

    const dimension = ref<Dimension>('model');

    const groups = computed(() => (dimension.value === 'model' ? props.byModel : props.byProvider));

    const selectedId = computed(() =>
        dimension.value === 'model' ? props.selectedModelId : props.selectedProviderId
    );

    const totalTokens = computed(() =>
        groups.value.reduce(
            (sum, group) =>
                sum +
                group.inputTokens +
                group.outputTokens +
                group.cacheReadTokens +
                group.cacheWriteTokens,
            0
        )
    );

    function tokensOf(group: UsageGroup): number {
        return (
            group.inputTokens + group.outputTokens + group.cacheReadTokens + group.cacheWriteTokens
        );
    }

    function share(group: UsageGroup): number {
        return totalTokens.value > 0 ? tokensOf(group) / totalTokens.value : 0;
    }

    function cacheRate(group: UsageGroup): number {
        const denominator = group.inputTokens + group.cacheWriteTokens + group.cacheReadTokens;
        return denominator > 0 ? group.cacheReadTokens / denominator : 0;
    }

    function handleSelect(group: UsageGroup) {
        if (group.id === null) {
            return;
        }

        const next = selectedId.value === group.id ? null : group.id;
        if (dimension.value === 'model') {
            emit('select-model', next);
        } else {
            emit('select-provider', next);
        }
    }
</script>

<template>
    <section class="space-y-3" data-testid="settings-usage-breakdown">
        <div class="flex items-center justify-between gap-3">
            <h2 class="settings-section-title">{{ t('settings.usage.breakdown.title') }}</h2>

            <div class="flex items-center gap-1">
                <button
                    v-for="option in ['model', 'provider'] as Dimension[]"
                    :key="option"
                    type="button"
                    :class="[
                        'rounded-[10px] px-3 py-1.5 text-xs transition-colors',
                        dimension === option
                            ? 'bg-[#e9e9e7] text-neutral-950'
                            : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                    ]"
                    :aria-pressed="dimension === option"
                    @click="dimension = option"
                >
                    {{ t(`settings.usage.breakdown.by.${option}`) }}
                </button>
            </div>
        </div>

        <div v-if="groups.length === 0" class="settings-row-group px-5 py-10 text-center">
            <span class="text-xs text-neutral-400">{{ t('settings.usage.group.empty') }}</span>
        </div>

        <div v-else class="settings-row-group divide-y divide-neutral-200/70">
            <div
                class="flex items-center gap-4 px-5 py-2 text-[11px] text-neutral-400"
                aria-hidden="true"
            >
                <span class="min-w-0 flex-1">
                    {{ t(`settings.usage.breakdown.by.${dimension}`) }}
                </span>
                <span class="w-16 shrink-0 text-right">
                    {{ t('settings.usage.table.calls') }}
                </span>
                <span class="w-16 shrink-0 text-right">
                    {{ t('settings.usage.table.tokens') }}
                </span>
                <span class="w-14 shrink-0 text-right">
                    {{ t('settings.usage.table.cacheRate') }}
                </span>
                <span class="w-14 shrink-0 text-right">
                    {{ t('settings.usage.table.ttft') }}
                </span>
                <span class="w-20 shrink-0 text-right">
                    {{ t('settings.usage.table.cost') }}
                </span>
            </div>

            <button
                v-for="group in groups"
                :key="`${dimension}-${group.id ?? group.name}`"
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
                    <div class="flex items-center gap-2">
                        <span class="truncate text-[13px] text-neutral-950" :title="group.name">
                            {{ group.name }}
                        </span>
                        <span
                            v-if="group.unpricedCount > 0"
                            class="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700"
                        >
                            {{
                                t('settings.usage.metric.unpriced', { count: group.unpricedCount })
                            }}
                        </span>
                    </div>
                    <div
                        class="mt-1.5 h-[3px] w-full max-w-56 overflow-hidden rounded-full bg-neutral-100"
                    >
                        <div
                            class="h-full rounded-full bg-neutral-800/60"
                            :style="{ width: `${Math.max(2, share(group) * 100)}%` }"
                        />
                    </div>
                </div>

                <span class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums">
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
