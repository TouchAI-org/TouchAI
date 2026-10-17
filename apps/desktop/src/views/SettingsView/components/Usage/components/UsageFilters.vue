<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type {
        UsageFilter,
        UsageFilterOptions,
        UsageRangePreset,
    } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { type MessageKey, t } from '@/i18n';

    import { formatInt } from '../utils/format';
    import { USAGE_RANGE_PRESETS } from '../utils/usageRange';

    interface Props {
        filter: UsageFilter;
        preset: UsageRangePreset;
        options: UsageFilterOptions;
        search: string;
        compact: boolean;
        maskText: (value: string) => string;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        (event: 'update:preset', value: UsageRangePreset): void;
        (event: 'update:modelIds', value: number[]): void;
        (event: 'update:providerIds', value: number[]): void;
        (event: 'update:statuses', value: UsageFilter['statuses']): void;
        (event: 'update:search', value: string): void;
    }>();

    defineOptions({ name: 'UsageFilters' });

    const STATUS_OPTIONS: Array<{
        value: NonNullable<UsageFilter['statuses']> | undefined;
        labelKey: MessageKey;
    }> = [
        { value: undefined, labelKey: 'settings.usage.status.all' },
        { value: ['completed'], labelKey: 'settings.usage.status.completed' },
        { value: ['failed'], labelKey: 'settings.usage.status.failed' },
        { value: ['cancelled'], labelKey: 'settings.usage.status.cancelled' },
    ];

    const selectedModelId = computed(() => props.filter.modelIds?.[0] ?? null);
    const selectedProviderId = computed(() => props.filter.providerIds?.[0] ?? null);

    function toggleModel(id: number) {
        emit('update:modelIds', selectedModelId.value === id ? [] : [id]);
        // 切换供应商会清空模型，反之亦然
        if (selectedModelId.value !== id) {
            emit('update:providerIds', props.filter.providerIds ?? []);
        }
    }

    function toggleProvider(id: number) {
        const next = selectedProviderId.value === id ? [] : [id];
        emit('update:providerIds', next);
        if (next.length > 0 && selectedModelId.value !== null) {
            // 避免「幽灵组合」：切供应商时清空模型
            emit('update:modelIds', []);
        }
    }
</script>

<template>
    <div class="flex flex-wrap items-center gap-1.5">
        <!-- 时间范围 -->
        <div class="flex h-8 shrink-0 items-center gap-0.5 rounded-[8px] bg-neutral-100 p-[3px]">
            <button
                v-for="range in USAGE_RANGE_PRESETS"
                :key="range"
                type="button"
                :class="[
                    'rounded-[6px] px-2.5 py-1 text-[11px] whitespace-nowrap transition-colors',
                    preset === range
                        ? 'bg-white font-semibold text-neutral-900 shadow-sm'
                        : 'text-neutral-500 hover:text-neutral-800',
                ]"
                :aria-pressed="preset === range"
                @click="emit('update:preset', range)"
            >
                {{ t(`settings.usage.range.${range}`) }}
            </button>
        </div>

        <div class="min-w-2 flex-1" />

        <!-- 搜索 -->
        <div class="relative">
            <input
                :value="search"
                type="search"
                :placeholder="t('settings.usage.filter.search')"
                class="h-8 w-40 rounded-[8px] border border-neutral-200/70 bg-white px-2.5 text-[11px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
                @input="emit('update:search', ($event.target as HTMLInputElement).value)"
            />
        </div>

        <!-- 供应商 -->
        <details class="group relative">
            <summary
                class="flex h-8 cursor-pointer list-none items-center gap-1 rounded-[8px] border border-neutral-200/70 bg-white px-2.5 text-[11px] text-neutral-700 hover:border-neutral-300"
            >
                <span class="max-w-24 truncate">
                    {{
                        selectedProviderId === null
                            ? t('settings.usage.filter.provider.all')
                            : maskText(
                                  options.providers.find((item) => item.id === selectedProviderId)
                                      ?.name ?? ''
                              )
                    }}
                </span>
                <span class="text-neutral-300">▾</span>
            </summary>
            <div
                class="absolute right-0 z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-[11px] border border-neutral-200 bg-white p-1 shadow-lg"
            >
                <button
                    type="button"
                    :class="[
                        'flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[11px] hover:bg-neutral-50',
                        selectedProviderId === null
                            ? 'font-semibold text-neutral-900'
                            : 'text-neutral-700',
                    ]"
                    @click="emit('update:providerIds', [])"
                >
                    <span class="flex-1 truncate">
                        {{ t('settings.usage.filter.provider.all') }}
                    </span>
                </button>
                <button
                    v-for="provider in options.providers"
                    :key="provider.id"
                    type="button"
                    :class="[
                        'flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[11px] hover:bg-neutral-50',
                        selectedProviderId === provider.id
                            ? 'font-semibold text-neutral-900'
                            : 'text-neutral-700',
                    ]"
                    @click="toggleProvider(provider.id)"
                >
                    <span class="min-w-0 flex-1 truncate">{{ maskText(provider.name) }}</span>
                    <span class="shrink-0 text-neutral-400 tabular-nums">
                        {{ formatInt(provider.count) }}
                    </span>
                </button>
            </div>
        </details>

        <!-- 模型 -->
        <details class="group relative">
            <summary
                class="flex h-8 cursor-pointer list-none items-center gap-1 rounded-[8px] border border-neutral-200/70 bg-white px-2.5 text-[11px] text-neutral-700 hover:border-neutral-300"
            >
                <span class="max-w-24 truncate">
                    {{
                        selectedModelId === null
                            ? t('settings.usage.filter.model.all')
                            : maskText(
                                  options.models.find((item) => item.id === selectedModelId)
                                      ?.name ?? ''
                              )
                    }}
                </span>
                <span class="text-neutral-300">▾</span>
            </summary>
            <div
                class="absolute right-0 z-20 mt-1 max-h-72 w-60 overflow-y-auto rounded-[11px] border border-neutral-200 bg-white p-1 shadow-lg"
            >
                <button
                    type="button"
                    :class="[
                        'flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[11px] hover:bg-neutral-50',
                        selectedModelId === null
                            ? 'font-semibold text-neutral-900'
                            : 'text-neutral-700',
                    ]"
                    @click="emit('update:modelIds', [])"
                >
                    <span class="flex-1 truncate">{{ t('settings.usage.filter.model.all') }}</span>
                </button>
                <button
                    v-for="model in options.models"
                    :key="model.id"
                    type="button"
                    :class="[
                        'flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[11px] hover:bg-neutral-50',
                        selectedModelId === model.id
                            ? 'font-semibold text-neutral-900'
                            : 'text-neutral-700',
                    ]"
                    @click="toggleModel(model.id)"
                >
                    <span class="min-w-0 flex-1 truncate">{{ maskText(model.name) }}</span>
                    <span class="shrink-0 text-neutral-400 tabular-nums">
                        {{ formatInt(model.count) }}
                    </span>
                </button>
            </div>
        </details>

        <!-- 状态 -->
        <details class="group relative">
            <summary
                class="flex h-8 cursor-pointer list-none items-center gap-1 rounded-[8px] border border-neutral-200/70 bg-white px-2.5 text-[11px] text-neutral-700 hover:border-neutral-300"
            >
                <span class="truncate">
                    {{
                        filter.onlyFailed
                            ? t('settings.usage.status.failed')
                            : filter.statuses?.length === 1 && filter.statuses[0] === 'cancelled'
                              ? t('settings.usage.status.cancelled')
                              : filter.onlyRetried
                                ? t('settings.usage.status.retried')
                                : t('settings.usage.status.all')
                    }}
                </span>
                <span class="text-neutral-300">▾</span>
            </summary>
            <div
                class="absolute right-0 z-20 mt-1 w-40 rounded-[11px] border border-neutral-200 bg-white p-1 shadow-lg"
            >
                <button
                    v-for="option in STATUS_OPTIONS"
                    :key="option.labelKey"
                    type="button"
                    class="flex w-full items-center rounded-[7px] px-2 py-1.5 text-left text-[11px] text-neutral-700 hover:bg-neutral-50"
                    @click="emit('update:statuses', option.value ? [...option.value] : undefined)"
                >
                    {{ t(option.labelKey) }}
                </button>
                <button
                    type="button"
                    class="flex w-full items-center rounded-[7px] px-2 py-1.5 text-left text-[11px] text-neutral-700 hover:bg-neutral-50"
                    @click="emit('update:statuses', ['completed'])"
                >
                    {{ t('settings.usage.status.retried') }}
                </button>
            </div>
        </details>
    </div>
</template>
