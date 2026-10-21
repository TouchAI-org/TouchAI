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
        /** 两侧统一的高度（行数）；不传时按四行 */
        heightRows?: number;
    }

    const props = withDefaults(defineProps<Props>(), {
        supportsDuration: false,
        showIcon: false,
        loading: false,
        heightRows: undefined,
    });

    const emit = defineEmits<{ (event: 'update:metric', value: UsageRankMetric): void }>();

    defineOptions({ name: 'UsageRanking' });

    /** 单行高度 */
    const ROW_HEIGHT = 44;

    /** 高度按父级统一给的行数 */
    const targetRows = computed(() => Math.max(1, props.heightRows ?? 4));

    /** 实际显示的内容行数：多出的内部滚动 */
    const contentRows = computed(() => Math.min(props.items.length, targetRows.value));

    /**
     * 补齐的行数。
     *
     * 两侧高度必须一致，短的那一侧用与真实行同结构的骨架填满，
     * 而不是留一块空白——空白看起来像没加载完。
     */
    const placeholderRows = computed(() =>
        props.items.length === 0 ? 0 : targetRows.value - contentRows.value
    );

    /** 容器高度 */
    const boxHeight = computed(() => `${targetRows.value * ROW_HEIGHT}px`);

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
    <section
        class="flex h-full min-h-0 flex-col gap-3"
        :data-testid="`settings-usage-ranking-${metric}`"
    >
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

        <div class="flex min-h-0 flex-1 flex-col rounded-[11px] bg-neutral-50/80 p-4">
            <!-- 骨架写在组件内部：和真实内容同一份布局，不会因外部改动而漂移 -->
            <div v-if="loading && items.length === 0" class="space-y-2.5">
                <div v-for="row in 5" :key="row" class="space-y-1">
                    <div class="flex items-baseline gap-2">
                        <div class="h-3 flex-1 animate-pulse rounded bg-neutral-200/60" />
                        <div class="h-3 w-10 animate-pulse rounded bg-neutral-200/50" />
                    </div>
                    <div class="h-[5px] animate-pulse rounded-full bg-neutral-200/60" />
                </div>
            </div>

            <div v-else-if="items.length === 0" class="py-8 text-center">
                <span class="text-xs text-neutral-400">{{ t('settings.usage.group.empty') }}</span>
            </div>

            <!--
                高度固定为 4 行，不足 4 行用骨架补齐，这样并排的两侧永远等高。
                滚动条不可见但可滚动：`no-scrollbar` 只隐藏滚动条，不禁止滚动。
            -->
            <div
                v-else
                :class="['no-scrollbar overflow-y-auto', loading ? 'opacity-60' : '']"
                :style="{ height: boxHeight }"
            >
                <div
                    v-for="item in items"
                    :key="item.id"
                    data-testid="settings-usage-ranking-row"
                    class="flex items-center gap-2.5"
                    :style="{ height: `${ROW_HEIGHT}px` }"
                    :title="[item.name, subtitleOf(item)].filter(Boolean).join('\n')"
                >
                    <span class="w-[42%] min-w-0 shrink-0 truncate text-[12.5px] text-neutral-900">
                        {{ item.name }}
                    </span>

                    <div
                        class="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-200/70"
                    >
                        <div
                            class="h-full rounded-full bg-neutral-800/70"
                            :style="{ width: barWidth(item) }"
                        />
                    </div>

                    <span
                        class="w-14 shrink-0 text-right text-[12px] text-neutral-600 tabular-nums"
                    >
                        {{ valueText(item) }}
                    </span>
                </div>

                <!-- 补齐到 4 行：与真实行同高同结构，但不带数字，避免被误读 -->
                <div
                    v-for="row in placeholderRows"
                    :key="`placeholder-${row}`"
                    class="flex items-center gap-2.5"
                    :style="{ height: `${ROW_HEIGHT}px` }"
                    aria-hidden="true"
                    data-testid="settings-usage-ranking-placeholder"
                >
                    <div class="h-3 w-[42%] shrink-0 rounded bg-neutral-200/40" />
                    <div class="h-[5px] min-w-0 flex-1 rounded-full bg-neutral-200/40" />
                    <div class="h-3 w-10 shrink-0 rounded bg-neutral-200/40" />
                </div>
            </div>
        </div>
    </section>
</template>
