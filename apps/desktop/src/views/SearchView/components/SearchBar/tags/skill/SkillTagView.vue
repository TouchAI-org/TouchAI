<script setup lang="ts">
    import SkillLabel from '@components/SkillLabel.vue';
    import type { NodeViewProps } from '@tiptap/core';
    import { NodeViewWrapper } from '@tiptap/vue-3';
    import { computed } from 'vue';

    import { hasRangeSelectedDecoration } from '../utils';

    const props = defineProps<Pick<NodeViewProps, 'node' | 'decorations'>>();
    const isRangeSelected = computed(() => hasRangeSelectedDecoration(props.decorations));
</script>

<template>
    <NodeViewWrapper
        as="span"
        :data-range-selected="isRangeSelected"
        data-search-tag
        data-search-tag-kind="skill"
        data-skill-tag
        :data-skill-name="node.attrs.name"
        :data-skill-path="node.attrs.path"
        contenteditable="false"
    >
        <SkillLabel :name="node.attrs.name" accent />
    </NodeViewWrapper>
</template>
