<!--
  模型标签 Vue NodeView。
  运行时完全替代 factory renderHTML 输出，提供响应式交互能力。
  data-search-tag / data-model-tag 等属性需与 renderHTML 保持一致，
  供编辑器点击处理和 CSS 选择器使用。
-->
<template>
    <NodeViewWrapper
        as="span"
        class="search-tag-chip search-tag-chip--model"
        :class="{
            'search-tag-range-selected': isRangeSelected,
        }"
        data-search-tag
        data-search-tag-kind="model"
        data-model-tag
        :data-model-id="node.attrs.modelId"
        contenteditable="false"
    >
        <span class="search-tag-content">
            <span class="search-tag-label search-tag-label--model">
                @{{ node.attrs.modelName }}
            </span>
            <button
                class="search-tag-close search-tag-close--model"
                data-tag-close
                type="button"
                contenteditable="false"
                @mousedown.prevent.stop="deleteNode"
            >
                ×
            </button>
        </span>
    </NodeViewWrapper>
</template>

<script setup lang="ts">
    import type { NodeViewProps } from '@tiptap/core';
    import { NodeViewWrapper } from '@tiptap/vue-3';
    import { computed } from 'vue';

    import { hasRangeSelectedDecoration } from '../utils';

    const props = defineProps<Pick<NodeViewProps, 'node' | 'deleteNode' | 'decorations'>>();

    const isRangeSelected = computed(() => hasRangeSelectedDecoration(props.decorations));
</script>

<style scoped>
    .search-tag-chip--model {
        border: 0 solid transparent;
        border-inline-width: 0.25rem;
        border-radius: 0.375rem;
        background-clip: padding-box;
        background-color: var(--color-blue-100);
        padding: 0 0.5rem;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--color-blue-700);
    }

    .search-tag-close--model {
        color: var(--color-blue-700);
    }

    .search-tag-close--model:hover {
        background-color: var(--color-blue-200);
    }

    .search-tag-chip--model.search-tag-range-selected {
        box-shadow: inset 0 0 0 1px var(--color-blue-200);
    }

    .search-tag-chip--model.ProseMirror-selectednode {
        background-color: var(--color-blue-100);
        box-shadow: inset 0 0 0 1px var(--color-blue-300);
    }
</style>
