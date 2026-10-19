<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import type { UsageFilterOptions, UsageRangePreset } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { USAGE_RANGE_PRESETS } from '../utils/usageRange';

    type StatusValue = 'all' | 'completed' | 'failed' | 'cancelled' | 'retried';

    interface Props {
        preset: UsageRangePreset;
        status: StatusValue;
        providerId: number | null;
        modelId: number | null;
        search: string;
        options: UsageFilterOptions;
        loading: boolean;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        (event: 'update:preset', value: UsageRangePreset): void;
        (event: 'update:status', value: StatusValue): void;
        (event: 'update:providerId', value: number | null): void;
        (event: 'update:modelId', value: number | null): void;
        (event: 'update:search', value: string): void;
    }>();

    defineOptions({ name: 'UsageToolbar' });

    const rangeOptions = computed(() =>
        USAGE_RANGE_PRESETS.map((preset) => ({
            label: t(`settings.usage.range.${preset}`),
            value: preset,
        }))
    );

    const statusOptions = computed<Array<{ label: string; value: StatusValue }>>(() => [
        { label: t('settings.usage.status.all'), value: 'all' },
        { label: t('settings.usage.status.completed'), value: 'completed' },
        { label: t('settings.usage.status.failed'), value: 'failed' },
        { label: t('settings.usage.status.cancelled'), value: 'cancelled' },
        { label: t('settings.usage.status.retried'), value: 'retried' },
    ]);

    const providerOptions = computed(() => [
        { label: t('settings.usage.filter.provider.all'), value: 0 },
        ...props.options.providers.map((provider) => ({
            label: provider.name,
            value: provider.id,
        })),
    ]);

    const modelOptions = computed(() => [
        { label: t('settings.usage.filter.model.all'), value: 0 },
        ...props.options.models.map((model) => ({
            label: model.name,
            value: model.id,
        })),
    ]);

    function handleProviderChange(value: number) {
        emit('update:providerId', value === 0 ? null : value);
        // 供应商与模型互斥，避免查出空集
        if (value !== 0) {
            emit('update:modelId', null);
        }
    }

    function handleModelChange(value: number) {
        emit('update:modelId', value === 0 ? null : value);
        if (value !== 0) {
            emit('update:providerId', null);
        }
    }

    /** 「全部」时按钮回到未选中态，避免看起来像一直在筛选 */
    const hasActiveFilter = computed(
        () =>
            props.status !== 'all' ||
            props.providerId !== null ||
            props.modelId !== null ||
            props.search.trim().length > 0
    );

    function resetFilters() {
        emit('update:status', 'all');
        emit('update:providerId', null);
        emit('update:modelId', null);
        emit('update:search', '');
    }
</script>

<template>
    <div class="flex flex-wrap items-center justify-end gap-1.5">
        <div class="w-[92px]">
            <CustomSelect
                :model-value="preset"
                :options="rangeOptions"
                :disabled="loading"
                trigger-test-id="settings-usage-range-trigger"
                @update:model-value="emit('update:preset', $event as UsageRangePreset)"
            />
        </div>

        <div class="w-[92px]">
            <CustomSelect
                :model-value="status"
                :options="statusOptions"
                :disabled="loading"
                trigger-test-id="settings-usage-status-trigger"
                @update:model-value="emit('update:status', $event as StatusValue)"
            />
        </div>

        <div class="w-[110px]">
            <CustomSelect
                :model-value="providerId ?? 0"
                :options="providerOptions"
                :disabled="loading"
                protect-option-text
                trigger-test-id="settings-usage-provider-trigger"
                @update:model-value="handleProviderChange"
            />
        </div>

        <div class="w-[120px]">
            <CustomSelect
                :model-value="modelId ?? 0"
                :options="modelOptions"
                :disabled="loading"
                protect-option-text
                trigger-test-id="settings-usage-model-trigger"
                @update:model-value="handleModelChange"
            />
        </div>

        <div class="relative w-[140px]">
            <input
                :value="search"
                type="text"
                :placeholder="t('settings.usage.filter.search')"
                class="settings-input w-full py-1.5 pr-2 pl-7 text-xs"
                @input="emit('update:search', ($event.target as HTMLInputElement).value)"
            />
            <AppIcon
                name="search"
                class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400"
            />
        </div>

        <button
            v-if="hasActiveFilter"
            type="button"
            class="flex h-7 items-center gap-1 rounded-[9px] px-2 text-[11px] text-neutral-500 transition-colors hover:bg-[#f1f1ef] hover:text-neutral-800"
            data-testid="settings-usage-reset-filters"
            @click="resetFilters"
        >
            <AppIcon name="close" class="h-3 w-3" />
            {{ t('settings.usage.filter.reset') }}
        </button>
    </div>
</template>
