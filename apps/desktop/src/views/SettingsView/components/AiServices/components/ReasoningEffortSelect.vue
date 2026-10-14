<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import type { ProviderDriver } from '@database/schema';
    import { computed } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import type { ReasoningEffort } from '@/services/AgentService/contracts/reasoning';
    import {
        getDefaultReasoningEffort,
        getProviderReasoningCapabilities,
    } from '@/services/AgentService/infrastructure/providers';

    interface Props {
        driver?: ProviderDriver;
    }

    const props = defineProps<Props>();

    const effortLabelKeys: Record<ReasoningEffort, MessageKey> = {
        none: 'model.reasoningEffort.none',
        minimal: 'model.reasoningEffort.minimal',
        low: 'model.reasoningEffort.low',
        medium: 'model.reasoningEffort.medium',
        high: 'model.reasoningEffort.high',
        xhigh: 'model.reasoningEffort.xhigh',
        max: 'model.reasoningEffort.max',
    };

    const capabilities = computed(() =>
        props.driver ? getProviderReasoningCapabilities(props.driver) : undefined
    );
    const isSupported = computed(() => capabilities.value?.supportsReasoning === true);
    const selectedEffort = computed<ReasoningEffort>(
        () => getDefaultReasoningEffort(props.driver) ?? 'none'
    );
    const options = computed(() =>
        (capabilities.value?.supportedEfforts ?? []).map((effort) => ({
            label: t(effortLabelKeys[effort]),
            value: effort,
        }))
    );
</script>

<template>
    <div>
        <label class="block text-sm font-medium text-neutral-700">
            {{ t('model.reasoningEffort.label') }}
        </label>
        <CustomSelect
            v-if="isSupported"
            :model-value="selectedEffort"
            :options="options"
            class="mt-1.5"
            disabled
        />
        <div
            v-else
            class="mt-1.5 rounded-[10px] border border-transparent bg-gray-50 px-3 py-2 text-sm text-gray-400"
        >
            {{ t('model.reasoningEffort.unsupported') }}
        </div>
        <p v-if="isSupported" class="mt-1 text-xs text-neutral-400">
            {{ t('model.reasoningEffort.disabledHint') }}
        </p>
    </div>
</template>
