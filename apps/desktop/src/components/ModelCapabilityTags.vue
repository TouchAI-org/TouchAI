<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import { Badge } from '@components/ui/badge';
    import { computed } from 'vue';

    import { type MessageKey, t } from '@/i18n';
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
    type BadgeTone = 'blue' | 'green' | 'purple' | 'orange' | 'indigo' | 'gray';

    const tags = computed(() => {
        const result: Array<{ labelKey: CapabilityLabelKey; tone: BadgeTone }> = [];

        if (props.model.reasoning === 1) {
            result.push({ labelKey: 'model.capability.reasoning', tone: 'blue' });
        }
        if (props.model.tool_call === 1) {
            result.push({ labelKey: 'model.capability.tools', tone: 'green' });
        }
        if (props.model.modalities) {
            const modalities = parseModelModalities(props.model.modalities);
            if (supportsImageModality(modalities)) {
                result.push({ labelKey: 'model.capability.multimodal', tone: 'purple' });
            }
        }
        if (props.model.attachment === 1) {
            result.push({ labelKey: 'model.capability.files', tone: 'orange' });
        }
        if (props.model.open_weights === 1) {
            result.push({ labelKey: 'model.capability.openWeights', tone: 'indigo' });
        }

        if (result.length === 0) {
            result.push({ labelKey: 'model.capability.text', tone: 'gray' });
        }

        return result;
    });
</script>

<template>
    <div class="flex min-w-0 flex-wrap items-center gap-1">
        <Badge
            v-for="tag in tags"
            :key="`${tag.tone}-${tag.labelKey}`"
            variant="tag"
            :size="size"
            :tone="tag.tone"
        >
            {{ t(tag.labelKey) }}
        </Badge>
    </div>
</template>
