<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

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

    const tags = computed(() => {
        const result: Array<{ label: string; color: string }> = [];

        if (props.model.reasoning === 1) {
            result.push({ label: '推理', color: 'blue' });
        }
        if (props.model.tool_call === 1) {
            result.push({ label: '工具', color: 'green' });
        }
        if (props.model.modalities) {
            const modalities = parseModelModalities(props.model.modalities);
            if (supportsImageModality(modalities)) {
                result.push({ label: '多模态', color: 'purple' });
            }
        }
        if (props.model.attachment === 1) {
            result.push({ label: '文件', color: 'orange' });
        }
        if (props.model.open_weights === 1) {
            result.push({ label: '开源', color: 'indigo' });
        }

        if (result.length === 0) {
            result.push({ label: '文本', color: 'gray' });
        }

        return result;
    });

    const sizeClass = computed(() => {
        return props.size === 'sm'
            ? 'px-1 py-0.5 text-[10px] leading-none'
            : 'px-1.5 py-0.5 text-xs';
    });
</script>

<template>
    <div class="flex flex-wrap items-center gap-1">
        <span
            v-for="tag in tags"
            :key="tag.label"
            :class="[
                'rounded font-medium',
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
            {{ tag.label }}
        </span>
    </div>
</template>
