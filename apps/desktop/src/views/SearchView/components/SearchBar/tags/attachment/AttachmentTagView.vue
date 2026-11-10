<!--
  附件标签 Vue NodeView。
  根据 fileType 动态展示：图片显示缩略图预览，文件显示行内引用。
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
        data-no-i18n="true"
        translate="no"
        :data-attachment-id="node.attrs.attachmentId"
        :data-attachment-file="!isImage ? '' : undefined"
        :title="tooltipText"
        contenteditable="false"
    >
        <span
            v-if="!isImage"
            class="inline-flex max-w-full min-w-0 items-baseline gap-1 align-baseline text-text-info"
        >
            <AppIcon
                name="document-text"
                class="h-4 w-4 shrink-0 translate-y-0.5 self-center"
                aria-hidden="true"
            />
            <span class="min-w-0 break-words">{{ fileName }}</span>
        </span>
        <span v-else class="search-tag-content">
            <img
                v-if="node.attrs.preview"
                :src="node.attrs.preview"
                :alt="fileName"
                class="attachment-tag-preview"
                data-no-i18n="true"
                translate="no"
            />
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
    import AppIcon from '@components/AppIcon.vue';
    import type { NodeViewProps } from '@tiptap/core';
    import { NodeViewWrapper } from '@tiptap/vue-3';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { hasRangeSelectedDecoration } from '../utils';

    const props = defineProps<Pick<NodeViewProps, 'node' | 'deleteNode' | 'decorations'>>();

    const fileName = computed(() => props.node.attrs.fileName || 'file');
    const isImage = computed(() => props.node.attrs.fileType === 'image');

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
            return `${fileName.value}${t('conversation.attachment.unsupportedImageSuffix')}`;
        }
        if (props.node.attrs.supportStatus === 'unsupported-file') {
            return `${fileName.value}${t('conversation.attachment.unsupportedFileSuffix')}`;
        }
        return fileName.value;
    });
</script>

<style scoped>
    .search-tag-chip--image {
        background-color: var(--color-surface-hover);
        padding: 0 var(--spacing);
        color: var(--color-text-secondary);
        margin-left: 0;
        margin-right: 0;
        box-shadow: inset 0 0 0 1px var(--color-border);
    }

    .search-tag-chip--unsupported {
        opacity: 0.5;
        filter: grayscale(1);
    }

    .search-tag-chip--image .search-tag-content {
        gap: var(--spacing);
    }

    .attachment-tag-preview {
        display: inline-block;
        width: calc(var(--spacing) * 4);
        height: calc(var(--spacing) * 4);
        flex-shrink: 0;
        margin-right: var(--spacing);
        border-radius: var(--radius-xs);
        object-fit: cover;
        pointer-events: none;
    }

    .search-tag-close--attachment {
        color: var(--color-text-tertiary);
    }

    .search-tag-close--attachment:hover {
        background-color: var(--color-surface-active);
    }

    .search-tag-chip--attachment.search-tag-range-selected {
        box-shadow: inset 0 0 0 1px var(--color-selection-outline);
    }

    .search-tag-chip--attachment.ProseMirror-selectednode {
        background-color: var(--color-selection-bg);
        box-shadow: inset 0 0 0 1px var(--color-selection-outline);
    }
</style>
