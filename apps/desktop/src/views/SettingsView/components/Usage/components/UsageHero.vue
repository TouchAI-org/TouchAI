<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageSummary } from '@database/queries/usageStats';
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
        compact: boolean;
        /** 打码映射：把模型名/供应商名替换成占位符 */
        maskText: (value: string) => string;
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageHero' });

    const showMore = ref(false);

    const primaryCards = computed(() => [
        {
            key: 'cost',
            label: t('settings.usage.metric.cost'),
            value: formatCost(props.summary.totalCostMicros),
            /** 有未定价调用时显示 ≥ 前缀，绝不把未知当 0 */
            prefix: props.summary.unpricedCount > 0 ? '≥ ' : '',
            note:
                props.summary.unpricedCount > 0
                    ? t('settings.usage.metric.unpriced', { count: props.summary.unpricedCount })
                    : t('settings.usage.metric.costNote'),
        },
        {
            key: 'requests',
            label: t('settings.usage.metric.requests'),
            value: String(props.summary.requestCount),
            prefix: '',
            note: t('settings.usage.metric.requestsNote', {
                rate: formatPercent(props.summary.successRate),
            }),
        },
        {
            key: 'tokens',
            label: t('settings.usage.metric.realTokens'),
            value: formatTokensCompact(props.summary.realTotalTokens),
            prefix: '',
            note: t('settings.usage.metric.realTokensNote'),
        },
        {
            key: 'cache',
            label: t('settings.usage.metric.cacheHitRate'),
            value: formatPercent(props.summary.cacheHitRate),
            prefix: '',
            note: t('settings.usage.metric.cacheHitRateNote'),
        },
    ]);

    const moreMetrics = computed(() => [
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
            key: 'cacheWrite',
            label: t('settings.usage.metric.cacheWrite'),
            value: formatTokensCompact(props.summary.cacheWriteTokens),
        },
        {
            key: 'cacheRead',
            label: t('settings.usage.metric.cacheRead'),
            value: formatTokensCompact(props.summary.cacheReadTokens),
        },
        {
            key: 'reasoning',
            label: t('settings.usage.metric.reasoning'),
            value: formatTokensCompact(props.summary.reasoningTokens),
            note: t('settings.usage.metric.reasoningNote'),
        },
        {
            key: 'ttft',
            label: t('settings.usage.metric.ttft'),
            value: formatDuration(props.summary.meanTtftMs),
        },
    ]);
</script>

<template>
    <section :aria-label="t('settings.usage.metric.label')" class="flex flex-col gap-3">
        <div :class="['grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-4']">
            <div
                v-for="card in primaryCards"
                :key="card.key"
                class="flex min-w-0 flex-col justify-between gap-1 rounded-[13px] border border-neutral-200/70 bg-white px-4 py-3"
            >
                <span class="truncate text-xs text-neutral-500">{{ card.label }}</span>
                <span
                    class="truncate font-serif text-2xl leading-tight font-semibold text-neutral-900 tabular-nums"
                    :title="card.value"
                >
                    {{ card.prefix }}{{ card.value }}
                </span>
                <span class="truncate text-[11px] text-neutral-400">{{ card.note }}</span>
            </div>
        </div>

        <button
            type="button"
            class="self-start text-xs text-neutral-500 transition-colors hover:text-neutral-800"
            :aria-expanded="showMore"
            @click="showMore = !showMore"
        >
            {{ showMore ? t('settings.usage.metric.less') : t('settings.usage.metric.more') }}
        </button>

        <div v-if="showMore" :class="['grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-6']">
            <div
                v-for="metric in moreMetrics"
                :key="metric.key"
                class="flex min-w-0 flex-col rounded-[11px] bg-neutral-50 px-3 py-2"
            >
                <span class="truncate text-[11px] text-neutral-500">{{ metric.label }}</span>
                <span class="truncate text-sm text-neutral-800 tabular-nums" :title="metric.value">
                    {{ metric.value }}
                </span>
                <span v-if="metric.note" class="truncate text-[10px] text-neutral-400">
                    {{ metric.note }}
                </span>
            </div>
        </div>
    </section>
</template>
