<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import MotionCollapse from '@components/MotionCollapse.vue';
    import type { UsageCallRow } from '@database/queries/usageStats';
    import { ref } from 'vue';

    import { type MessageKey, t } from '@/i18n';

    import {
        formatCost,
        formatDbTime,
        formatDuration,
        formatInt,
        formatPercent,
        formatTokensCompact,
    } from '../utils/format';

    interface Props {
        rows: UsageCallRow[];
        total: number;
        offset: number;
        limit: number;
        /** 重新查询时保持旧数据并降低不透明度，避免列表跳动 */
        loading: boolean;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{ (event: 'change-page', offset: number): void }>();

    defineOptions({ name: 'UsageCallList' });

    const expandedPartId = ref<number | null>(null);

    function toggle(partId: number) {
        expandedPartId.value = expandedPartId.value === partId ? null : partId;
    }

    function totalTokens(row: UsageCallRow): number {
        return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    }

    function cacheRate(row: UsageCallRow): number | null {
        const denominator = row.inputTokens + row.cacheWriteTokens + row.cacheReadTokens;
        if (denominator <= 0) return null;
        return row.cacheReadTokens / denominator;
    }

    /** 调用结局：错误 > 截断 > 完成 */
    function outcome(row: UsageCallRow): { key: MessageKey; className: string } {
        if (row.errorMessage) {
            return {
                key: 'settings.usage.call.outcome.failed',
                className: 'bg-red-100 text-red-700',
            };
        }
        if (row.finishReason === 'length') {
            return {
                key: 'settings.usage.call.outcome.truncated',
                className: 'bg-orange-100 text-orange-700',
            };
        }
        return {
            key: 'settings.usage.call.outcome.completed',
            className: 'bg-green-100 text-green-700',
        };
    }

    function canPrev(): boolean {
        return props.offset > 0;
    }

    function canNext(): boolean {
        return props.offset + props.limit < props.total;
    }
</script>

<template>
    <div>
        <div v-if="rows.length === 0" class="settings-row-group px-5 py-12 text-center">
            <AppIcon name="document-text" class="mx-auto h-12 w-12 text-neutral-300" />
            <p class="mt-3 text-sm text-neutral-500">{{ t('settings.usage.calls.empty') }}</p>
        </div>

        <div v-else :class="['space-y-2 transition-opacity', loading ? 'opacity-60' : '']">
            <div
                v-for="row in rows"
                :key="row.partId"
                data-testid="settings-usage-call-row"
                class="overflow-hidden rounded-[11px] border border-neutral-200/80 bg-white"
            >
                <button
                    type="button"
                    class="w-full px-5 py-3 text-left transition-colors hover:bg-[#f1f1ef]"
                    :aria-expanded="expandedPartId === row.partId"
                    @click="toggle(row.partId)"
                >
                    <div class="flex items-start justify-between gap-4">
                        <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">
                                <span
                                    class="truncate text-[13px] text-neutral-950"
                                    data-no-i18n="true"
                                    translate="no"
                                >
                                    {{ row.modelName }}
                                </span>
                                <span
                                    :class="[
                                        'rounded px-2 py-0.5 text-xs whitespace-nowrap',
                                        outcome(row).className,
                                    ]"
                                >
                                    {{ t(outcome(row).key) }}
                                </span>
                                <span class="text-[11px] text-neutral-500" translate="no">
                                    {{ row.providerName }}
                                </span>
                            </div>
                            <div
                                class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-neutral-500"
                            >
                                <span class="tabular-nums">{{ formatDbTime(row.createdAt) }}</span>
                                <span class="tabular-nums">
                                    {{
                                        t('settings.usage.call.tokens', {
                                            value: formatTokensCompact(totalTokens(row)),
                                        })
                                    }}
                                </span>
                                <span v-if="cacheRate(row) !== null" class="tabular-nums">
                                    {{ t('settings.usage.table.cacheRate') }}
                                    {{ formatPercent(cacheRate(row) ?? 0) }}
                                </span>
                                <span v-if="row.ttftMs !== null" class="tabular-nums">
                                    {{ t('settings.usage.table.ttft') }}
                                    {{ formatDuration(row.ttftMs) }}
                                </span>
                                <span v-if="row.durationMs !== null" class="tabular-nums">
                                    {{ formatDuration(row.durationMs) }}
                                </span>
                            </div>
                        </div>

                        <div class="flex shrink-0 items-center gap-3">
                            <span
                                :class="[
                                    'text-[13px] tabular-nums',
                                    row.priced ? 'text-neutral-950' : 'text-amber-600',
                                ]"
                            >
                                {{
                                    row.priced
                                        ? formatCost(row.costMicros)
                                        : t('settings.usage.calls.unpriced')
                                }}
                            </span>
                            <AppIcon
                                name="chevron-right"
                                :class="
                                    expandedPartId === row.partId
                                        ? 'h-4 w-4 rotate-90 text-neutral-400 transition-transform'
                                        : 'h-4 w-4 text-neutral-400 transition-transform'
                                "
                            />
                        </div>
                    </div>
                </button>

                <MotionCollapse :open="expandedPartId === row.partId" lazy>
                    <div class="border-t border-neutral-200/70 bg-neutral-50/70 px-5 py-3">
                        <dl class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] lg:grid-cols-3">
                            <div class="flex justify-between gap-2">
                                <dt class="text-neutral-500">
                                    {{ t('settings.usage.detail.freshInput') }}
                                </dt>
                                <dd class="text-neutral-800 tabular-nums">
                                    {{ formatInt(row.inputTokens) }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-2">
                                <dt class="text-neutral-500">
                                    {{ t('settings.usage.detail.output') }}
                                </dt>
                                <dd class="text-neutral-800 tabular-nums">
                                    {{ formatInt(row.outputTokens) }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-2">
                                <dt class="text-neutral-500">
                                    {{ t('settings.usage.detail.cacheRead') }}
                                </dt>
                                <dd class="text-neutral-800 tabular-nums">
                                    {{ formatInt(row.cacheReadTokens) }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-2">
                                <dt class="text-neutral-500">
                                    {{ t('settings.usage.detail.cacheWrite') }}
                                </dt>
                                <dd class="text-neutral-800 tabular-nums">
                                    {{ formatInt(row.cacheWriteTokens) }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-2">
                                <dt class="text-neutral-500">
                                    {{ t('settings.usage.detail.reasoning') }}
                                </dt>
                                <dd class="text-neutral-800 tabular-nums">
                                    {{ formatInt(row.reasoningTokens) }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-2">
                                <dt class="text-neutral-500">
                                    {{ t('settings.usage.detail.finishReason') }}
                                </dt>
                                <dd class="truncate text-neutral-800">
                                    {{ row.finishReason ?? '—' }}
                                </dd>
                            </div>
                        </dl>

                        <div
                            v-if="row.sessionTitle || row.errorMessage"
                            class="mt-3 space-y-1.5 border-t border-neutral-200 pt-3 text-[12px]"
                        >
                            <div v-if="row.sessionTitle" class="flex gap-2">
                                <span class="shrink-0 text-neutral-500">
                                    {{ t('settings.usage.detail.session') }}
                                </span>
                                <span class="min-w-0 truncate text-neutral-800">
                                    {{ row.sessionTitle }}
                                </span>
                            </div>
                            <div v-if="row.errorMessage" class="flex gap-2">
                                <span class="shrink-0 text-neutral-500">
                                    {{ t('settings.usage.detail.error') }}
                                </span>
                                <span class="min-w-0 break-words text-red-600">
                                    {{ row.errorMessage }}
                                </span>
                            </div>
                        </div>
                    </div>
                </MotionCollapse>
            </div>

            <div
                v-if="total > limit"
                class="flex items-center justify-between pt-2 text-[12px] text-neutral-500"
            >
                <span class="tabular-nums">
                    {{
                        t('settings.usage.calls.page', {
                            from: offset + 1,
                            to: Math.min(offset + limit, total),
                            total,
                        })
                    }}
                </span>
                <div class="flex gap-2">
                    <button
                        type="button"
                        class="settings-button-secondary"
                        :disabled="!canPrev()"
                        @click="emit('change-page', Math.max(0, offset - limit))"
                    >
                        {{ t('settings.usage.calls.prev') }}
                    </button>
                    <button
                        type="button"
                        class="settings-button-secondary"
                        :disabled="!canNext()"
                        @click="emit('change-page', offset + limit)"
                    >
                        {{ t('settings.usage.calls.next') }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
