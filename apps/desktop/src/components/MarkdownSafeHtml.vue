<script setup lang="ts">
    import DOMPurify from 'dompurify';
    import { computed } from 'vue';

    defineOptions({ inheritAttrs: false });
    const props = defineProps<{ node: { type: string; content: string } }>();
    // Raw model HTML must not bypass the image component's explicit loading action.
    const content = computed(() =>
        DOMPurify.sanitize(props.node.content, {
            FORBID_TAGS: [
                'style',
                'link',
                'iframe',
                'object',
                'embed',
                'audio',
                'video',
                'source',
                'img',
                'svg',
                'math',
            ],
            FORBID_ATTR: ['style', 'src', 'srcset', 'poster', 'background', 'data', 'ping'],
        })
    );
</script>

<template>
    <span v-if="node.type === 'html_inline'" v-html="content" />
    <div v-else v-html="content" />
</template>
