<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageGroup } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { formatCost, formatDuration, formatTokensCompact } from '../utils/format';

    interface Props {
        title: string;
        groups: UsageGroup[];
        selectedId: number | null;
        maskText: (value: string) => string;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{ (event: 'select', id: number | null): void }>();

    defineOptions({ name: 'UsageGroupList' });

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

    function speed(group: UsageGroup): string | null {
        if (!group.meanDurationMs || group.outputTokens <= 0) return null;
        const tokensPerSecond =
            group.outputTokens / group.requestCount / (group.meanDurationMs / 1000);
        return Number.isFinite(tokensPerSecond) ? `${tokensPerSecond.toFixed(1)} tok/s` : null;
    }
</script>

<template>
    <section class="flex flex-col gap-1.5">
        <h3 class="text-xs font-medium tracking-wide text-neutral-500">{{ title }}</h3>

        <div
            v-if="groups.length === 0"
            class="rounded-[13px] border border-neutral-200/70 bg-white py-8 text-center"
        >
            <span class="text-xs text-neutral-400">{{ t('settings.usage.group.empty') }}</span>
        </div>

        <div v-else class="overflow-hidden rounded-[13px] border border-neutral-200/70 bg-white">
            <button
                v-for="(group, index) in groups"
                :key="group.id ?? group.name"
                type="button"
                :class="[
                    'flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-neutral-50/70',
                    index > 0 ? 'border-t border-neutral-100' : '',
                    selectedId === group.id ? 'bg-neutral-50' : '',
                ]"
                @click="emit('select', selectedId === group.id ? null : group.id)"
            >
                <div class="flex items-baseline justify-between gap-3">
                    <span
                        :class="[
                            'min-w-0 truncate text-sm',
                            selectedId === group.id
                                ? 'font-semibold text-neutral-900'
                                : 'text-neutral-800',
                        ]"
                        :title="group.name"
                    >
                        {{ maskText(group.name) }}
                    </span>
                    <span class="shrink-0 text-sm text-neutral-800 tabular-nums">
                        {{ formatCost(group.totalCostMicros) }}
                    </span>
                </div>

                <div
                    class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-neutral-500"
                >
                    <span class="tabular-nums">
                        {{ t('settings.usage.group.requests', { count: group.requestCount }) }}
                    </span>
                    <span class="tabular-nums">
                        {{
                            formatTokensCompact(
                                group.inputTokens +
                                    group.outputTokens +
                                    group.cacheReadTokens +
                                    group.cacheWriteTokens
                            )
                        }}
                        {{ t('settings.usage.group.tokens') }}
                    </span>
                    <span v-if="group.unpricedCount > 0" class="text-amber-600">
                        {{ t('settings.usage.metric.unpriced', { count: group.unpricedCount }) }}
                    </span>
                    <span v-if="group.meanTtftMs !== null" class="tabular-nums">
                        {{ t('settings.usage.group.ttft') }} {{ formatDuration(group.meanTtftMs) }}
                    </span>
                    <span v-if="speed(group)" class="tabular-nums">{{ speed(group) }}</span>
                </div>

                <div class="h-[3px] w-full overflow-hidden rounded-full bg-neutral-100">
                    <div
                        class="h-full rounded-full bg-neutral-800/70"
                        :style="{ width: `${Math.max(2, share(group) * 100)}%` }"
                    />
                </div>
            </button>
        </div>
    </section>
</template>
