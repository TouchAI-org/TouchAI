<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageSummary } from '@database/queries/usageStats';

    import { t } from '@/i18n';

    import {
        formatCost,
        formatDuration,
        formatPercent,
        formatTokensCompact,
    } from '../utils/format';

    interface Props {
        summary: UsageSummary;
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageMetrics' });

    /** 主指标：花费、请求数、真实 token、缓存命中率 */
    function primaryMetrics(summary: UsageSummary) {
        return [
            {
                key: 'cost',
                label: t('settings.usage.metric.cost'),
                value: formatCost(summary.totalCostMicros),
                /** 有未定价调用时加 ≥ 前缀，绝不把未知当 0 */
                prefix: summary.unpricedCount > 0 ? '≥ ' : '',
                note:
                    summary.unpricedCount > 0
                        ? t('settings.usage.metric.unpriced', { count: summary.unpricedCount })
                        : t('settings.usage.metric.costNote'),
                warn: summary.unpricedCount > 0,
            },
            {
                key: 'requests',
                label: t('settings.usage.metric.requests'),
                value: String(summary.requestCount),
                prefix: '',
                note: t('settings.usage.metric.requestsNote', {
                    rate: formatPercent(summary.successRate),
                }),
                warn: false,
            },
            {
                key: 'tokens',
                label: t('settings.usage.metric.realTokens'),
                value: formatTokensCompact(summary.realTotalTokens),
                prefix: '',
                note: t('settings.usage.metric.realTokensNote'),
                warn: false,
            },
            {
                key: 'cache',
                label: t('settings.usage.metric.cacheHitRate'),
                value: formatPercent(summary.cacheHitRate),
                prefix: '',
                note: t('settings.usage.metric.cacheHitRateNote'),
                warn: false,
            },
        ];
    }

    /** 次级指标：口径拆分，默认折叠 */
    function secondaryMetrics(summary: UsageSummary) {
        return [
            {
                key: 'input',
                label: t('settings.usage.metric.freshInput'),
                value: formatTokensCompact(summary.inputTokens),
                note: '',
            },
            {
                key: 'output',
                label: t('settings.usage.metric.output'),
                value: formatTokensCompact(summary.outputTokens),
                note: '',
            },
            {
                key: 'cacheWrite',
                label: t('settings.usage.metric.cacheWrite'),
                value: formatTokensCompact(summary.cacheWriteTokens),
                note: '',
            },
            {
                key: 'cacheRead',
                label: t('settings.usage.metric.cacheRead'),
                value: formatTokensCompact(summary.cacheReadTokens),
                note: '',
            },
            {
                key: 'reasoning',
                label: t('settings.usage.metric.reasoning'),
                value: formatTokensCompact(summary.reasoningTokens),
                note: t('settings.usage.metric.reasoningNote'),
            },
            {
                key: 'ttft',
                label: t('settings.usage.metric.ttft'),
                value: formatDuration(summary.meanTtftMs),
                note: '',
            },
        ];
    }
</script>

<template>
    <section class="space-y-4">
        <h2 class="settings-section-title">{{ t('settings.usage.metric.label') }}</h2>

        <div class="settings-row-group p-4">
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div
                    v-for="card in primaryMetrics(props.summary)"
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
                    v-for="metric in secondaryMetrics(props.summary)"
                    :key="metric.key"
                    class="flex items-baseline justify-between gap-2 text-xs"
                >
                    <span class="min-w-0 truncate text-neutral-500">{{ metric.label }}</span>
                    <span class="shrink-0 text-neutral-800 tabular-nums" :title="metric.value">
                        {{ metric.value }}
                        <span v-if="metric.note" class="ml-1 text-[11px] text-neutral-400">
                            {{ metric.note }}
                        </span>
                    </span>
                </div>
            </div>
        </div>
    </section>
</template>
