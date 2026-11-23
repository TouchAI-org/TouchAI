<script setup lang="ts">
    import { computed } from 'vue';

    import type { PrivacyReviewAnnotation } from '@/app/api/privacy';

    import PrivacyProtectionTooltip from './PrivacyProtectionTooltip.vue';

    const props = withDefaults(
        defineProps<{
            text: string;
            annotations: PrivacyReviewAnnotation[];
            offset?: number;
        }>(),
        { offset: 0 }
    );
    const parts = computed(() => {
        const result: Array<{ text: string; annotation?: PrivacyReviewAnnotation }> = [];
        let cursor = 0;
        for (const annotation of props.annotations) {
            const start = annotation.start - props.offset;
            const end = annotation.end - props.offset;
            if (
                start < cursor ||
                end > props.text.length ||
                props.text.slice(start, end) !== annotation.original
            )
                continue;
            if (start > cursor) result.push({ text: props.text.slice(cursor, start) });
            result.push({ text: annotation.original, annotation });
            cursor = end;
        }
        if (cursor < props.text.length) result.push({ text: props.text.slice(cursor) });
        return result;
    });
</script>

<template>
    <template v-for="(part, index) in parts" :key="index">
        <PrivacyProtectionTooltip v-if="part.annotation" :annotation="part.annotation" />
        <template v-else>{{ part.text }}</template>
    </template>
</template>
