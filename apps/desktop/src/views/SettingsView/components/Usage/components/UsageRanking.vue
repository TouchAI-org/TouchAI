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
        /** Whether the "active" metric is offered; sessions only. */
        supportsDuration?: boolean;
        /** Whether to show an icon; unused by the model ranking. */
        /** Whether to show an icon. Kept for older call sites. */
        showIcon?: boolean;
        loading?: boolean;
        /** Row count shared by both sides; defaults to four. */
        heightRows?: number;
        /** Currently selected item id, used to highlight the active filter. */
        selectedId?: number | null;
    }

    const props = withDefaults(defineProps<Props>(), {
        supportsDuration: false,
        showIcon: false,
        loading: false,
        heightRows: undefined,
        selectedId: null,
    });

    const emit = defineEmits<{
        (event: 'update:metric', value: UsageRankMetric): void;
        /** Clicking a row asks the parent to filter by it. */
        (event: 'select', id: number | null): void;
    }>();

    /**
     * Clicking the selected row again clears the filter, so returning to the
     * unfiltered view does not require hunting for a reset control.
     */
    function pick(id: number): void {
        emit('select', props.selectedId === id ? null : id);
    }

    defineOptions({ name: 'UsageRanking' });

    /** Height of one row. */
    const ROW_HEIGHT = 44;

    /** Row count dictated by the parent, so both sides match. */
    const targetRows = computed(() => Math.max(1, props.heightRows ?? 4));

    /** Rows actually rendered; any excess scrolls inside the box. */
    const contentRows = computed(() => Math.min(props.items.length, targetRows.value));

    /**
     * Number of skeleton rows needed to fill the box.
     *
     * Both sides must be the same height, so the shorter one pads with
     * skeletons that mirror the real row layout instead of leaving a gap, which
     * would read as "still loading".
     */
    const placeholderRows = computed(() =>
        props.items.length === 0 ? 0 : targetRows.value - contentRows.value
    );

    /** Container height. */
    const boxHeight = computed(() => `${targetRows.value * ROW_HEIGHT}px`);

    /** Bars are relative to the leader, not to the total; the latter hides rank 5. */
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

    /** Session subtitle: model · last active. */
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
                <button
                    v-for="item in items"
                    :key="item.id"
                    type="button"
                    data-testid="settings-usage-ranking-row"
                    class="flex w-full items-center gap-2.5 rounded-[9px] px-2 text-left transition-colors"
                    :class="
                        selectedId === item.id
                            ? 'bg-neutral-900/[0.06]'
                            : 'hover:bg-neutral-900/[0.04]'
                    "
                    :style="{ height: `${ROW_HEIGHT}px` }"
                    :title="[item.name, subtitleOf(item)].filter(Boolean).join('\n')"
                    :aria-pressed="selectedId === item.id"
                    @click="pick(item.id)"
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
                </button>

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
