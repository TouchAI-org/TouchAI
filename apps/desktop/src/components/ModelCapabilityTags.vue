<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

    import { t, type MessageKey } from '@/i18n';
    import { parseModelModalities, supportsImageModality } from '@/utils/modelSchemas';

    interface ModelCapabilitySource {
        reasoning?: number | null;
        tool_call?: number | null;
        modalities?: string | null;
        attachment?: number | null;
        open_weights?: number | null;
    }

    interface Props {
        model: ModelCapabilitySource;
        size?: 'sm' | 'md';
    }

    const props = withDefaults(defineProps<Props>(), {
        size: 'md',
    });

    type CapabilityLabelKey = Extract<MessageKey, `model.capability.${string}`>;

    const tags = computed(() => {
        const result: Array<{ labelKey: CapabilityLabelKey; color: string }> = [];

        if (props.model.reasoning === 1) {
            result.push({ labelKey: 'model.capability.reasoning', color: 'blue' });
        }
        if (props.model.tool_call === 1) {
            result.push({ labelKey: 'model.capability.tools', color: 'green' });
        }
        if (props.model.modalities) {
            const modalities = parseModelModalities(props.model.modalities);
            if (supportsImageModality(modalities)) {
                result.push({ labelKey: 'model.capability.multimodal', color: 'purple' });
            }
        }
        if (props.model.attachment === 1) {
            result.push({ labelKey: 'model.capability.files', color: 'orange' });
        }
        if (props.model.open_weights === 1) {
            result.push({ labelKey: 'model.capability.openWeights', color: 'indigo' });
        }

        if (result.length === 0) {
            result.push({ labelKey: 'model.capability.text', color: 'gray' });
        }

        return result;
    });

    const sizeClass = computed(() => {
        return props.size === 'sm'
            ? 'max-w-[5.75rem] px-1 py-0.5 text-[10px] leading-tight'
            : 'max-w-[7.5rem] px-1.5 py-0.5 text-xs leading-tight';
    });
</script>

<template>
    <div class="flex min-w-0 flex-wrap items-center gap-1">
        <span
            v-for="tag in tags"
            :key="`${tag.color}-${tag.labelKey}`"
            :class="[
                'inline-flex min-w-0 items-center rounded text-center font-medium break-words whitespace-normal',
                sizeClass,
                {
                    'bg-blue-50 text-blue-600': tag.color === 'blue',
                    'bg-green-50 text-green-600': tag.color === 'green',
                    'bg-purple-50 text-purple-600': tag.color === 'purple',
                    'bg-orange-50 text-orange-600': tag.color === 'orange',
                    'bg-indigo-50 text-indigo-600': tag.color === 'indigo',
                    'bg-gray-100 text-gray-500': tag.color === 'gray',
                },
            ]"
        >
            {{ t(tag.labelKey) }}
        </span>
    </div>
</template>
