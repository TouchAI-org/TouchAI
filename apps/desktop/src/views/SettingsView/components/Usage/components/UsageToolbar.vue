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
        /** 重新查询中；用于禁用控件而不是清空数据 */
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
            label: `${provider.name} · ${provider.count}`,
            value: provider.id,
        })),
    ]);

    const modelOptions = computed(() => [
        { label: t('settings.usage.filter.model.all'), value: 0 },
        ...props.options.models.map((model) => ({
            label: `${model.name} · ${model.count}`,
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
</script>

<template>
    <div class="flex flex-wrap items-center gap-2">
        <div class="w-32">
            <CustomSelect
                :model-value="preset"
                :options="rangeOptions"
                :disabled="loading"
                trigger-test-id="settings-usage-range-trigger"
                @update:model-value="emit('update:preset', $event as UsageRangePreset)"
            />
        </div>

        <div class="w-32">
            <CustomSelect
                :model-value="status"
                :options="statusOptions"
                :disabled="loading"
                trigger-test-id="settings-usage-status-trigger"
                @update:model-value="emit('update:status', $event as StatusValue)"
            />
        </div>

        <div class="w-40">
            <CustomSelect
                :model-value="providerId ?? 0"
                :options="providerOptions"
                :disabled="loading"
                protect-option-text
                trigger-test-id="settings-usage-provider-trigger"
                @update:model-value="handleProviderChange"
            />
        </div>

        <div class="w-44">
            <CustomSelect
                :model-value="modelId ?? 0"
                :options="modelOptions"
                :disabled="loading"
                protect-option-text
                trigger-test-id="settings-usage-model-trigger"
                @update:model-value="handleModelChange"
            />
        </div>

        <div class="relative min-w-40 flex-1">
            <input
                :value="search"
                type="text"
                :placeholder="t('settings.usage.filter.search')"
                class="settings-input w-full py-2 pr-3 pl-9"
                @input="emit('update:search', ($event.target as HTMLInputElement).value)"
            />
            <AppIcon
                name="search"
                class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400"
            />
        </div>
    </div>
</template>
