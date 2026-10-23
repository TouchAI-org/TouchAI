<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import { Input } from '@components/ui/input';
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
        // Provider and model are mutually exclusive, otherwise the query matches nothing.
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
</script>

<template>
    <div class="usage-filters flex shrink-0 items-center gap-1.5">
        <!-- 时间范围的选项文字最长（「近 24 小时」），给得宽一点避免截断 -->
        <div class="w-[98px]">
            <CustomSelect
                :model-value="preset"
                :options="rangeOptions"
                :disabled="loading"
                trigger-test-id="settings-usage-range-trigger"
                @update:model-value="emit('update:preset', $event as UsageRangePreset)"
            />
        </div>

        <div class="w-[86px]">
            <CustomSelect
                :model-value="status"
                :options="statusOptions"
                :disabled="loading"
                trigger-test-id="settings-usage-status-trigger"
                @update:model-value="emit('update:status', $event as StatusValue)"
            />
        </div>

        <div class="w-[96px]">
            <CustomSelect
                :model-value="providerId ?? 0"
                :options="providerOptions"
                :disabled="loading"
                protect-option-text
                trigger-test-id="settings-usage-provider-trigger"
                @update:model-value="handleProviderChange"
            />
        </div>

        <div class="w-[100px]">
            <CustomSelect
                :model-value="modelId ?? 0"
                :options="modelOptions"
                :disabled="loading"
                protect-option-text
                trigger-test-id="settings-usage-model-trigger"
                @update:model-value="handleModelChange"
            />
        </div>

        <div class="relative w-[150px]">
            <Input
                :model-value="search"
                variant="filled"
                type="text"
                :placeholder="t('settings.usage.filter.search')"
                class="h-auto w-full py-1 pr-2 pl-6 text-xs"
                @update:model-value="emit('update:search', $event)"
            />
            <AppIcon
                name="search"
                class="pointer-events-none absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-neutral-400"
            />
        </div>
    </div>
</template>

<style scoped>
    /*
     * CustomSelect hardcodes its sizing in static classes (h-9 px-3 py-2 text-sm).
     * Passing utility classes from the call site only ties with them, so which
     * one wins depends on Tailwind's output order. A parent-plus-element selector
     * raises specificity and makes the override deterministic.
     *
     * h-9 is a fixed height, so padding alone cannot shrink it. The dropdown is
     * portalled to body and falls outside this selector, so option text keeps
     * its normal size.
     */
    .usage-filters :deep(button) {
        height: auto;
        padding: 4px 8px;
        font-size: 12px;
        line-height: 1rem;
    }
</style>
