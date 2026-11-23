<script setup lang="ts">
    import { InlineCodeNode, TextNode } from 'markstream-vue';

    import type { PrivacyReviewAnnotation } from '@/app/api/privacy';

    import PrivacyAnnotatedText from './PrivacyAnnotatedText.vue';

    defineOptions({ inheritAttrs: false });
    defineProps<{
        node: (
            | { type: 'text'; content: string; raw: string; center?: boolean }
            | { type: 'inline_code'; code: string; raw: string }
        ) & {
            privacyAnnotations?: PrivacyReviewAnnotation[];
        };
    }>();
</script>

<template>
    <component
        :is="node.type === 'inline_code' ? 'code' : 'span'"
        v-if="node.privacyAnnotations?.length"
        v-bind="$attrs"
        :class="node.type === 'inline_code' ? 'inline-code' : 'text-node'"
    >
        <PrivacyAnnotatedText
            :text="node.type === 'text' ? node.content : node.code"
            :annotations="node.privacyAnnotations"
        />
    </component>
    <TextNode v-else-if="node.type === 'text'" v-bind="$attrs" :node="node" />
    <InlineCodeNode v-else v-bind="$attrs" :node="node" />
</template>
