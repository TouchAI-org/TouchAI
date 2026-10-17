<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { UsageCallRow } from '@database/queries/usageStats';
    import { ref } from 'vue';

    import { t } from '@/i18n';

    import {
        formatCost,
        formatDbTime,
        formatDuration,
        formatInt,
        formatTokensCompact,
    } from '../utils/format';

    interface Props {
        rows: UsageCallRow[];
        total: number;
        offset: number;
        limit: number;
        compact: boolean;
        maskText: (value: string) => string;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{ (event: 'change-page', offset: number): void }>();

    defineOptions({ name: 'UsageCallTable' });

    const expandedPartId = ref<number | null>(null);

    function toggle(partId: number) {
        expandedPartId.value = expandedPartId.value === partId ? null : partId;
    }

    function totalTokens(row: UsageCallRow): number {
        return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    }

    function cacheRate(row: UsageCallRow): string | null {
        const denominator = row.inputTokens + row.cacheWriteTokens + row.cacheReadTokens;
        if (denominator <= 0) return null;
        return `${((row.cacheReadTokens / denominator) * 100).toFixed(0)}%`;
    }

    function canPrev(): boolean {
        return props.offset > 0;
    }

    function canNext(): boolean {
        return props.offset + props.limit < props.total;
    }
</script>

<template>
    <section class="flex flex-col gap-2">
        <div
            v-if="rows.length === 0"
            class="rounded-[13px] border border-neutral-200/70 bg-white py-10 text-center"
        >
            <span class="text-xs text-neutral-400">{{ t('settings.usage.calls.empty') }}</span>
        </div>

        <div v-else class="overflow-hidden rounded-[13px] border border-neutral-200/70 bg-white">
            <button
                v-for="(row, index) in rows"
                :key="row.partId"
                type="button"
                :class="[
                    'flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-neutral-50/70',
                    index > 0 ? 'border-t border-neutral-100' : '',
                    expandedPartId === row.partId ? 'bg-neutral-50' : '',
                ]"
                @click="toggle(row.partId)"
            >
                <div class="flex items-baseline justify-between gap-3">
                    <span
                        class="min-w-0 flex-1 truncate text-sm text-neutral-800"
                        :title="row.modelName"
                    >
                        {{ maskText(row.modelName) }}
                        <span class="ml-1.5 text-[11px] text-neutral-400">
                            {{ maskText(row.providerName) }}
                        </span>
                    </span>
                    <span class="shrink-0 text-sm text-neutral-800 tabular-nums">
                        {{
                            row.priced
                                ? formatCost(row.costMicros)
                                : t('settings.usage.calls.unpriced')
                        }}
                    </span>
                </div>

                <div
                    class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-neutral-500"
                >
                    <span class="tabular-nums">{{ formatDbTime(row.createdAt) }}</span>
                    <span class="tabular-nums">
                        {{ formatTokensCompact(totalTokens(row)) }} tokens
                    </span>
                    <span v-if="cacheRate(row)" class="tabular-nums">
                        {{ t('settings.usage.calls.cacheRate') }} {{ cacheRate(row) }}
                    </span>
                    <span v-if="row.ttftMs !== null" class="tabular-nums">
                        TTFT {{ formatDuration(row.ttftMs) }}
                    </span>
                    <span v-if="row.durationMs !== null" class="tabular-nums">
                        {{ formatDuration(row.durationMs) }}
                    </span>
                    <span v-if="row.errorMessage" class="text-red-600">
                        {{ row.finishReason ?? 'error' }}
                    </span>
                </div>

                <!-- 展开详情 -->
                <dl
                    v-if="expandedPartId === row.partId"
                    class="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 rounded-[9px] bg-white/70 px-2.5 py-2 text-[11px]"
                >
                    <div class="flex justify-between gap-2">
                        <dt class="text-neutral-500">
                            {{ t('settings.usage.detail.freshInput') }}
                        </dt>
                        <dd class="text-neutral-800 tabular-nums">
                            {{ formatInt(row.inputTokens) }}
                        </dd>
                    </div>
                    <div class="flex justify-between gap-2">
                        <dt class="text-neutral-500">{{ t('settings.usage.detail.output') }}</dt>
                        <dd class="text-neutral-800 tabular-nums">
                            {{ formatInt(row.outputTokens) }}
                        </dd>
                    </div>
                    <div class="flex justify-between gap-2">
                        <dt class="text-neutral-500">{{ t('settings.usage.detail.cacheRead') }}</dt>
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
                        <dt class="text-neutral-500">{{ t('settings.usage.detail.reasoning') }}</dt>
                        <dd class="text-neutral-800 tabular-nums">
                            {{ formatInt(row.reasoningTokens) }}
                        </dd>
                    </div>
                    <div class="flex justify-between gap-2">
                        <dt class="text-neutral-500">
                            {{ t('settings.usage.detail.finishReason') }}
                        </dt>
                        <dd class="truncate text-neutral-800">{{ row.finishReason ?? '—' }}</dd>
                    </div>
                    <div v-if="row.sessionTitle" class="col-span-2 flex justify-between gap-2">
                        <dt class="text-neutral-500">{{ t('settings.usage.detail.session') }}</dt>
                        <dd class="min-w-0 truncate text-neutral-800">
                            {{ maskText(row.sessionTitle) }}
                        </dd>
                    </div>
                    <div v-if="row.errorMessage" class="col-span-2 flex flex-col gap-0.5">
                        <dt class="text-neutral-500">{{ t('settings.usage.detail.error') }}</dt>
                        <dd class="break-words text-red-600">{{ row.errorMessage }}</dd>
                    </div>
                </dl>
            </button>
        </div>

        <div
            v-if="total > limit"
            class="flex items-center justify-between text-[11px] text-neutral-500"
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
            <div class="flex gap-1">
                <button
                    type="button"
                    :disabled="!canPrev()"
                    class="rounded-[7px] border border-neutral-200/70 px-2 py-1 transition-colors enabled:hover:border-neutral-300 disabled:opacity-40"
                    @click="emit('change-page', Math.max(0, offset - limit))"
                >
                    {{ t('settings.usage.calls.prev') }}
                </button>
                <button
                    type="button"
                    :disabled="!canNext()"
                    class="rounded-[7px] border border-neutral-200/70 px-2 py-1 transition-colors enabled:hover:border-neutral-300 disabled:opacity-40"
                    @click="emit('change-page', offset + limit)"
                >
                    {{ t('settings.usage.calls.next') }}
                </button>
            </div>
        </div>
    </section>
</template>
