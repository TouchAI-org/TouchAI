<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageSummary } from '@database/queries/usageStats';
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
        summary: UsageSummary;
    }

    const props = defineProps<Props>();

    defineOptions({ name: 'UsageOverview' });

    /** 首屏五个核心指标 */
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
            value: formatInt(props.summary.requestCount),
            prefix: '',
            note: t('settings.usage.metric.requestsNote', {
                rate: formatPercent(props.summary.successRate),
            }),
            warn: false,
        },
        {
            key: 'sessions',
            label: t('settings.usage.metric.sessions'),
            value: formatInt(props.summary.sessionCount),
            prefix: '',
            note: t('settings.usage.metric.sessionsNote'),
            warn: false,
        },
        {
            key: 'tokens',
            label: t('settings.usage.metric.tokens'),
            value: formatTokensCompact(props.summary.realTotalTokens),
            prefix: '',
            note: t('settings.usage.metric.tokensNote'),
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
</script>

<template>
    <section data-testid="settings-usage-overview">
        <div class="settings-row-group p-4">
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
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

            <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-neutral-100 pt-3">
                <div
                    v-for="item in secondaryMetrics"
                    :key="item.key"
                    class="flex items-baseline gap-2 text-xs"
                >
                    <span class="text-neutral-500">{{ item.label }}</span>
                    <span class="text-neutral-800 tabular-nums" :title="item.value">
                        {{ item.value }}
                    </span>
                </div>
            </div>
        </div>
    </section>
</template>
