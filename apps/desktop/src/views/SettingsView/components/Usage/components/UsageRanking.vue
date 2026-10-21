<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageRankItem, UsageRankMetric } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { formatCost, formatDbTime, formatDuration, formatTokensCompact } from '../utils/format';

    interface Props {
        title: string;
        items: UsageRankItem[];
        metric: UsageRankMetric;
        /** 是否提供「活跃」维度（会话才有） */
        supportsDuration?: boolean;
        /** 用于展示图标/色点的区分：模型排行不需要 */
        /** 是否展示图标（已移除，保留 prop 以兼容旧调用） */
        showIcon?: boolean;
        loading?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        supportsDuration: false,
        showIcon: false,
        loading: false,
    });

    const emit = defineEmits<{ (event: 'update:metric', value: UsageRankMetric): void }>();

    defineOptions({ name: 'UsageRanking' });

    /** 排行条按「相对榜首」的比例，而不是占总量的比例：后者会让第 5 名几乎看不见 */
    const peak = computed(() => Math.max(1, ...props.items.map((item) => valueOf(item))));

    function valueOf(item: UsageRankItem): number {
        if (props.metric === 'cost') return item.costMicros;
        if (props.metric === 'duration') return item.durationMs ?? 0;
        return item.tokens;
    }

    function barWidth(item: UsageRankItem): string {
        return `${Math.max(2, (valueOf(item) / peak.value) * 100)}%`;
    }

    function valueText(item: UsageRankItem): string {
        if (props.metric === 'cost') {
            return item.unpricedCount > 0
                ? `≥ ${formatCost(item.costMicros)}`
                : formatCost(item.costMicros);
        }
        if (props.metric === 'duration') return formatDuration(item.durationMs);
        return formatTokensCompact(item.tokens);
    }

    /** 会话条目的副标题：模型 · 最后活跃 */
    function subtitleOf(item: UsageRankItem): string {
        const parts = [item.subtitle, item.lastAt ? formatDbTime(item.lastAt) : null].filter(
            Boolean
        );
        return parts.join(' · ');
    }

    const metricOptions = computed<Array<{ value: UsageRankMetric; label: string }>>(() => {
        const base: Array<{ value: UsageRankMetric; label: string }> = [
            { value: 'tokens', label: t('settings.usage.ranking.metric.tokens') },
            { value: 'cost', label: t('settings.usage.ranking.metric.cost') },
        ];
        if (props.supportsDuration) {
            base.push({ value: 'duration', label: t('settings.usage.ranking.metric.duration') });
        }
        return base;
    });
</script>

<template>
    <section class="space-y-3" :data-testid="`settings-usage-ranking-${metric}`">
        <div class="flex items-center justify-between gap-3">
            <h2 class="settings-section-title">{{ title }}</h2>

            <div class="flex items-center gap-1">
                <button
                    v-for="option in metricOptions"
                    :key="option.value"
                    type="button"
                    :class="[
                        'rounded-[10px] px-2.5 py-1 text-[11px] transition-colors',
                        metric === option.value
                            ? 'bg-[#e9e9e7] text-neutral-950'
                            : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                    ]"
                    :aria-pressed="metric === option.value"
                    @click="emit('update:metric', option.value)"
                >
                    {{ option.label }}
                </button>
            </div>
        </div>

        <div class="rounded-[11px] bg-neutral-50/80 p-4">
            <div v-if="items.length === 0" class="py-8 text-center">
                <span class="text-xs text-neutral-400">{{ t('settings.usage.group.empty') }}</span>
            </div>

            <!--
                两只排行共用同一高度并各自内部滚动：
                模型只有 5 项、会话有 8 项，不限高会一边高一边矮，看起来像没对齐。
            -->
            <div
                v-else
                :class="[
                    'custom-scrollbar h-[236px] space-y-2.5 overflow-y-auto pr-1',
                    loading ? 'opacity-60' : '',
                ]"
            >
                <div
                    v-for="item in items"
                    :key="item.id"
                    data-testid="settings-usage-ranking-row"
                    class="flex items-center gap-3"
                >
                    <div class="min-w-0 flex-1">
                        <!-- 并排时每列只有半宽，标题与数值同排、条形独占一行更可读 -->
                        <div class="flex items-baseline gap-2">
                            <span
                                class="min-w-0 flex-1 truncate text-[12.5px] text-neutral-900"
                                :title="item.name"
                            >
                                {{ item.name }}
                            </span>
                            <span
                                class="shrink-0 text-[12px] text-neutral-600 tabular-nums"
                                :title="valueText(item)"
                            >
                                {{ valueText(item) }}
                            </span>
                        </div>

                        <div
                            class="mt-1 h-[5px] w-full overflow-hidden rounded-full bg-neutral-200/70"
                        >
                            <div
                                class="h-full rounded-full bg-neutral-800/70"
                                :style="{ width: barWidth(item) }"
                            />
                        </div>

                        <div
                            v-if="item.subtitle || item.lastAt"
                            class="mt-0.5 truncate text-[11px] text-neutral-400"
                        >
                            {{ subtitleOf(item) }}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>
</template>
