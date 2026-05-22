<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div
        data-testid="quick-search-panel"
        class="quick-search-panel mt-1.5 w-full rounded-lg border border-gray-200 bg-white/95 p-2 shadow-lg backdrop-blur"
        @click.self="handleBlankSurfaceClick"
    >
        <div
            :ref="assignScrollRef"
            :class="[
                'quick-search-scroll quick-search-scrollbar overflow-x-hidden overflow-y-auto',
                viewMode === 'list' && 'justify-start',
            ]"
            :style="scrollStyle"
            @scroll.passive="handleScroll"
            @click.self="handleBlankSurfaceClick"
        >
            <!-- 网格视图 -->
            <div
                v-if="viewMode === 'grid'"
                class="quick-search-grid"
                :style="gridStyle"
                @click.self="handleBlankSurfaceClick"
            >
                <button
                    v-for="(item, index) in results"
                    :key="item.path"
                    :ref="
                        (el) => {
                            if (el) itemRefs[index] = el as HTMLButtonElement;
                        }
                    "
                    type="button"
                    :title="getItemHoverTitle(item)"
                    :class="[
                        'flex h-[88px] w-[88px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl p-1 outline-none',
                        index === highlightedIndex ? 'bg-primary-100' : 'hover:bg-gray-100',
                    ]"
                    @click="handleItemClick(index)"
                    @contextmenu.prevent="handleContextMenu($event, index)"
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
            <!-- 列表视图 -->
            <div v-else class="quick-search-list" @click.self="handleBlankSurfaceClick">
                <QuickSearchListItem
                    v-for="(item, index) in results"
                    :key="item.path"
                    :ref="
                        (el) => {
                            if (el) itemRefs[index] = el as HTMLButtonElement;
                        }
                    "
                    :name="item.name"
                    :path="
                        item.source === 'file' || item.source === 'shortcut_file' ? item.path : ''
                    "
                    :icon-src="isImageItem(item) ? imagePreviewMap[item.path] : iconMap[item.path]"
                    :name-segments="getNameSegments(item.name)"
                    :highlighted="index === highlightedIndex"
                    @click="handleItemClick(index)"
                    @contextmenu="handleContextMenu($event, index)"
                />
            </div>
        </div>
        <!-- 状态栏 -->
        <div
            v-if="results.length > 0"
            class="quick-search-status flex items-center justify-end gap-2 px-1 pt-1"
        >
            <span
                v-if="isLoadingMore"
                class="inline-block h-3 w-3 animate-spin rounded-full border border-gray-300 border-t-gray-600"
            ></span>
            <span class="quick-search-status-text text-[11px] leading-none text-gray-400">
                {{ statusText }}
            </span>
            <button
                type="button"
                class="quick-search-view-toggle flex h-4 w-4 items-center justify-center text-gray-400 outline-none hover:text-gray-600"
                :title="viewMode === 'grid' ? '切换列表视图' : '切换网格视图'"
                @click="toggleViewMode"
            >
                <AppIcon :name="viewMode === 'grid' ? 'list-ul' : 'grid-alt'" class="h-3.5 w-3.5" />
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { ComponentPublicInstance } from 'vue';
    import { computed, toRef } from 'vue';

    import { useQuickSearchLogic } from './composables/useQuickSearchLogic';
    import QuickSearchListItem from './QuickSearchListItem.vue';

    defineOptions({
        name: 'QuickSearchPanel',
    });

    interface Props {
        open: boolean;
        searchQuery: string;
        enabled?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        enabled: true,
    });

    const emit = defineEmits<{
        blankClick: [];
        'update:open': [value: boolean];
    }>();

    const quickSearchLogic = useQuickSearchLogic({
        open: toRef(props, 'open'),
        searchQuery: toRef(props, 'searchQuery'),
        enabled: toRef(props, 'enabled'),
        emitOpenUpdate: (value) => emit('update:open', value),
    });

    const {
        results,
        highlightedIndex,
        itemRefs,
        scrollStyle,
        gridStyle,
        moveSelection,
        iconMap,
        imagePreviewMap,
        isImageItem,
        getItemHoverTitle,
        handleScroll,
        isContextMenuOpen,
        getNameSegments,
        handleItemClick,
        handleContextMenu,
        openContextMenuForItem,
        openContextMenuForHighlightedItem,
        open: openPanel,
        close: closePanel,
        syncClosedState,
        getHighlightedItem,
        openHighlightedItem,
        triggerSearch,
        goToPage,
        goToNextPage,
        goToPreviousPage,
        currentPage,
        totalResults,
        isLoadingMore,
        viewMode,
        toggleViewMode,
    } = quickSearchLogic;

    const scrollRef = quickSearchLogic.scrollRef;

    function assignScrollRef(el: Element | ComponentPublicInstance | null) {
        scrollRef.value = el as HTMLElement | null;
    }

    function handleBlankSurfaceClick() {
        emit('blankClick');
    }

    const statusText = computed(() => {
        const total = totalResults.value;
        const totalPages = Math.max(1, Math.ceil(total / 60));
        const currentPageNum =
            highlightedIndex.value >= 0
                ? Math.floor(highlightedIndex.value / 60) + 1
                : currentPage.value + 1;
        return `第 ${currentPageNum}/${totalPages} 页 · 共 ${total} 条`;
    });

    defineExpose({
        open: openPanel,
        close: closePanel,
        syncClosedState,
        moveSelection,
        getHighlightedItem,
        openHighlightedItem,
        triggerSearch,
        goToPage,
        goToNextPage,
        goToPreviousPage,
        openContextMenuForItem,
        openContextMenuForHighlightedItem,
        toggleViewMode,
        collapseToDefault: quickSearchLogic.collapseToDefault,
        isContextMenuOpen,
        closeContextMenu: quickSearchLogic.closeContextMenu,
    });
</script>

<style scoped src="./style.css"></style>
