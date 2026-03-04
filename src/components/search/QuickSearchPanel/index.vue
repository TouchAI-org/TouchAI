<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div
        v-if="isOpen"
        class="quick-search-panel mt-1.5 w-full rounded-lg border border-gray-200 bg-white/95 p-2 shadow-lg backdrop-blur"
    >
        <div
            ref="scrollRef"
            class="quick-search-scroll quick-search-scrollbar overflow-x-hidden overflow-y-auto"
            :style="scrollStyle"
            @scroll.passive="handleScroll"
        >
            <div class="quick-search-grid" :style="gridStyle">
                <button
                    v-for="(item, index) in results"
                    :key="item.path"
                    :ref="
                        (el) => {
                            if (el) itemRefs[index] = el as HTMLElement;
                        }
                    "
                    type="button"
                    :title="getItemHoverTitle(item)"
                    :class="[
                        'flex h-[88px] w-[88px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl p-1 transition-colors',
                        index === highlightedIndex ? 'bg-primary-100' : 'hover:bg-gray-100',
                    ]"
                    @click="handleItemClick(index)"
                >
                    <div
                        class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md"
                    >
                        <img
                            v-if="isImageItem(item) && imagePreviewMap[item.path]"
                            :src="imagePreviewMap[item.path]"
                            :alt="item.name"
                            loading="lazy"
                            decoding="async"
                            class="quick-search-image-thumbnail h-8 w-8 rounded object-cover"
                        />
                        <div
                            v-else-if="isImageItem(item)"
                            class="quick-search-icon-placeholder h-8 w-8 rounded-md"
                        ></div>
                        <img
                            v-else-if="iconMap[item.path]"
                            :src="iconMap[item.path]"
                            :alt="item.name"
                            class="h-8 w-8 rounded object-contain"
                        />
                        <div v-else class="quick-search-icon-placeholder h-8 w-8 rounded-md"></div>
                    </div>
                    <p
                        class="quick-search-name mt-1 h-8 w-full px-0.5 text-center text-[12px] leading-4 text-gray-700"
                    >
                        <span
                            v-for="(segment, segmentIndex) in getNameSegments(item.name)"
                            :key="`${item.path}-${segmentIndex}`"
                            :class="segment.matched ? 'quick-search-name-match' : ''"
                        >
                            {{ segment.text }}
                        </span>
                    </p>
                </button>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import { toRef } from 'vue';

    import { useQuickSearchLogic } from './useQuickSearchLogic';

    defineOptions({
        name: 'QuickSearchPanel',
    });

    interface Props {
        searchQuery: string;
        enabled?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        enabled: true,
    });

    const emit = defineEmits<{
        'update:open': [value: boolean];
    }>();

    const quickSearchLogic = useQuickSearchLogic({
        searchQuery: toRef(props, 'searchQuery'),
        enabled: toRef(props, 'enabled'),
        emitOpenUpdate: (value) => emit('update:open', value),
    });

    const {
        isOpen,
        results,
        highlightedIndex,
        itemRefs,
        scrollRef,
        scrollStyle,
        gridStyle,
        moveSelection,
        iconMap,
        imagePreviewMap,
        isImageItem,
        getItemHoverTitle,
        handleScroll,
        getNameSegments,
        handleItemClick,
        open,
        close,
        getHighlightedItem,
        openHighlightedItem,
        triggerSearch,
    } = quickSearchLogic;

    defineExpose({
        isOpen,
        open,
        close,
        moveSelection,
        getHighlightedItem,
        openHighlightedItem,
        triggerSearch,
    });
</script>

<style scoped src="./style.css"></style>
