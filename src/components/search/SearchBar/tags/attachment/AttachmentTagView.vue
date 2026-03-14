<!--
  附件标签 Vue NodeView。
  根据 fileType 动态展示：图片显示缩略图预览，文件显示截断文件名。
  支持 supportStatus 驱动置灰（opacity + grayscale）和悬停提示。
-->
<template>
    <NodeViewWrapper
        as="span"
        class="search-tag-chip search-tag-chip--attachment"
        :class="{
            'search-tag-chip--image': isImage,
            'search-tag-range-selected': isRangeSelected,
            'search-tag-chip--unsupported': isUnsupported,
        }"
        data-search-tag
        data-search-tag-kind="attachment"
        data-attachment-tag
        :data-attachment-id="node.attrs.attachmentId"
        :title="tooltipText"
        contenteditable="false"
    >
        <span class="search-tag-content">
            <img
                v-if="node.attrs.preview"
                :src="node.attrs.preview"
                :alt="fileName"
                class="attachment-tag-preview"
            />
            <span v-if="!isImage" class="search-tag-label search-tag-label--attachment">
                {{ truncatedName }}
            </span>
            <button
                class="search-tag-close search-tag-close--attachment"
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

    const fileName = computed(() => props.node.attrs.fileName || 'file');
    const isImage = computed(() => props.node.attrs.fileType === 'image');
    const truncatedName = computed(() => {
        const name = fileName.value;
        return name.length > 12 ? name.slice(0, 10) + '…' : name;
    });

    /**
     * 范围选区高亮：ProseMirror 的原生 ::selection 无法覆盖原子节点，
     * 因此通过 tagRangeSelectionPlugin 注入 Decoration，
     * 此处检测装饰类名来驱动视觉高亮。
     */
    const isRangeSelected = computed(() => hasRangeSelectedDecoration(props.decorations));

    /** 当前模型不支持该附件类型时为 true，驱动标签置灰样式。 */
    const isUnsupported = computed(
        () =>
            props.node.attrs.supportStatus === 'unsupported-image' ||
            props.node.attrs.supportStatus === 'unsupported-file'
    );

    /** 悬停提示：置灰时显示不支持原因，正常时显示文件名。 */
    const tooltipText = computed(() => {
        if (props.node.attrs.supportStatus === 'unsupported-image') {
            return `${fileName.value}（当前模型不支持图片）`;
        }
        if (props.node.attrs.supportStatus === 'unsupported-file') {
            return `${fileName.value}（当前模型不支持文件）`;
        }
        return fileName.value;
    });
</script>

<style scoped>
    .search-tag-chip--attachment {
        border: 0 solid transparent;
        border-inline-width: 0.125rem;
        background-clip: padding-box;
        background-color: var(--color-gray-50);
        padding: 0 0.375rem;
        color: var(--color-gray-700);
        margin-left: 0;
        margin-right: 0;
        box-shadow: inset 0 0 0 1px var(--color-gray-200);
    }

    .search-tag-chip--unsupported {
        opacity: 0.5;
        filter: grayscale(1);
    }

    .search-tag-chip--image {
        padding: 0 0.25rem;
    }

    .search-tag-chip--image .search-tag-content {
        gap: 0;
    }

    .attachment-tag-preview {
        display: inline-block;
        width: 1rem;
        height: 1rem;
        flex-shrink: 0;
        margin-right: 0.25rem;
        border-radius: 0.25rem;
        object-fit: cover;
        pointer-events: none;
    }

    .search-tag-label--attachment {
        max-width: 6rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .search-tag-close--attachment {
        color: var(--color-gray-500);
    }

    .search-tag-close--attachment:hover {
        background-color: var(--color-gray-200);
    }

    .search-tag-chip--attachment.search-tag-range-selected {
        box-shadow: inset 0 0 0 1px var(--color-blue-100);
    }

    .search-tag-chip--attachment.ProseMirror-selectednode {
        background-color: var(--color-blue-50);
        box-shadow: inset 0 0 0 1px var(--color-blue-200);
    }
</style>
