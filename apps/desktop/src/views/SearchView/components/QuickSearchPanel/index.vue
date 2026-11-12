<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <ResultPanel
        v-if="(results.length > 0 || props.open) && (compact || panelState?.kind !== 'empty')"
        ref="panel"
        data-testid="quick-search-panel"
        :layout="viewMode"
        :floating="compact"
        :list-id="referenceMode ? listId : undefined"
        :list-label="referenceMode ? t('search.results.files') : undefined"
        :active-item-id="activeItemId"
        :max-height="maxHeight"
        :viewport-height="panelState ? undefined : viewportHeight"
        :viewport-padding="viewportPadding"
        :row-height="compact ? RESULT_COMPACT_ROW_HEIGHT : undefined"
        :preserve-focus="referenceMode"
        :state="panelState"
        :status="statusGroups"
        :shortcuts="shortcuts"
        :busy="isLoadingMore || (referenceMode && searchState === 'loading' && results.length > 0)"
        @viewport-change="assignScrollRef"
        @scroll="handleScroll"
        @wheel="handleWheel"
        @blank-click="handleBlankSurfaceClick"
        @content-resize="emit('contentResize')"
    >
        <div
            :class="viewMode === 'grid' ? 'quick-search-grid' : 'flex w-full shrink-0 flex-col'"
            :style="viewMode === 'grid' ? gridStyle : undefined"
            @click.self="handleBlankSurfaceClick"
        >
            <ResultItem
                v-for="(item, index) in results"
                :id="referenceMode ? `${listId}-${index}` : undefined"
                :key="item.key"
                :ref="(el) => assignItemRef(el, index)"
                :title="item.result.description"
                :role="referenceMode ? 'option' : undefined"
                :aria-selected="referenceMode ? index === highlightedIndex : undefined"
                :aria-disabled="referenceMode && searchState !== 'ready' ? true : undefined"
                :tabindex="referenceMode ? -1 : undefined"
                :layout="viewMode"
                :compact="compact"
                :label="item.result.label"
                :description="item.result.description"
                :disabled="item.result.disabled"
                :segments="getNameSegments(item.result.label)"
                :icon-src="getResultIcon(item)"
                :icon-fit="isImageItem(fileSearchItem(item.result)) ? 'cover' : 'contain'"
                :highlighted="index === highlightedIndex"
                @click="handleResultClick(index)"
                @contextmenu="handleContextMenu($event, index)"
            />
        </div>
        <template v-if="!compact && results.length" #actions>
            <ResultShortcut
                data-testid="quick-search-view-toggle"
                as="button"
                :keys="viewToggleKeys"
                :label="viewToggleLabel"
                separator="+"
                :aria-label="viewToggleLabel"
                @mousedown.prevent
                @click="toggleViewMode"
            />
        </template>
    </ResultPanel>
</template>

<script setup lang="ts">
    import type { ComponentPublicInstance } from 'vue';
    import { computed, onBeforeUnmount, ref, toRef, useId, watch } from 'vue';

    import {
        ResultItem,
        ResultPanel,
        type ResultPanelShortcut,
        type ResultPanelState,
        ResultShortcut,
    } from '@/components/ui/result-panel';
    import { RESULT_COMPACT_ROW_HEIGHT } from '@/components/ui/result-panel/layout';
    import { t } from '@/i18n';
    import type {
        SearchActionOutcome,
        SearchActivationContext,
        SearchMatch,
    } from '@/services/SearchService';
    import { fileSearchItem } from '@/services/SearchService/files';
    import { useSettingsStore } from '@/stores/settings';
    import { formatShortcutForDisplay } from '@/utils/shortcuts';

    import type { FilePickerContext } from '../SearchBar/types';
    import { resolveAutocompleteCompletion } from '../SearchBar/utils/autocomplete';
    import { useQuickSearchLogic } from './composables/useQuickSearchLogic';

    defineOptions({
        name: 'QuickSearchPanel',
    });

    interface Props {
        open: boolean;
        searchQuery: string;
        enabled?: boolean;
        handoff?: boolean;
        referenceMode?: boolean;
        maxHeight?: number;
        compact?: boolean;
        getActivationContext?: () => Partial<
            Omit<SearchActivationContext, 'query' | 'epoch' | 'intent' | 'signal'>
        >;
    }

    const props = withDefaults(defineProps<Props>(), {
        enabled: true,
        handoff: false,
        referenceMode: false,
        maxHeight: undefined,
        compact: false,
        getActivationContext: undefined,
    });

    const emit = defineEmits<{
        actionOutcome: [outcome: SearchActionOutcome];
        blankClick: [];
        'update:open': [value: boolean];
        reference: [index: number];
        referenceStateChange: [context: FilePickerContext | null];
        contentResize: [];
    }>();
    const panel = ref<InstanceType<typeof ResultPanel>>();

    const settingsStore = useSettingsStore();

    const quickSearchLogic = useQuickSearchLogic({
        open: toRef(props, 'open'),
        searchQuery: toRef(props, 'searchQuery'),
        enabled: toRef(props, 'enabled'),
        handoff: toRef(props, 'handoff'),
        referenceMode: toRef(props, 'referenceMode'),
        compact: toRef(props, 'compact'),
        maxHeight: toRef(props, 'maxHeight'),
        emitOpenUpdate: (value) => emit('update:open', value),
        getActivationContext: () => props.getActivationContext?.() ?? {},
        onActionOutcome: (outcome) => emit('actionOutcome', outcome),
    });

    const {
        items: results,
        searchState,
        highlightedIndex,
        itemRefs,
        viewportHeight,
        viewportPadding,
        gridStyle,
        moveSelection,
        iconMap,
        imagePreviewMap,
        isImageItem,
        handleScroll,
        handleWheel,
        isContextMenuOpen,
        getNameSegments,
        handleItemClick,
        handleContextMenu,
        openContextMenuForItem,
        openContextMenuForHighlightedItem,
        open: openPanel,
        close: closePanel,
        settleInteraction,
        getHighlightedItem,
        getReferenceCandidate,
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
    function getResultIcon(match: SearchMatch) {
        const file = fileSearchItem(match.result);
        return file
            ? isImageItem(file)
                ? imagePreviewMap.value[file.path]
                : iconMap.value[file.path]
            : match.result.iconSrc;
    }
    const listId = `file-picker-${useId()}`;
    const activeItemId = computed(() =>
        highlightedIndex.value >= 0 ? `${listId}-${highlightedIndex.value}` : undefined
    );
    const completion = computed(() => {
        if (!props.open || !props.enabled || searchState.value !== 'ready') return null;
        const target = resolveAutocompleteCompletion(
            props.searchQuery.trim(),
            results.value,
            highlightedIndex.value,
            (match) => match.result.label,
            results.value.length === totalResults.value
        );
        return target && getReferenceCandidate(target.index)
            ? { ...target, query: props.searchQuery.trim() }
            : null;
    });
    watch(
        [() => props.open, activeItemId, completion],
        () => {
            emit(
                'referenceStateChange',
                props.open
                    ? { listId, activeItemId: activeItemId.value, completion: completion.value }
                    : null
            );
        },
        { immediate: true }
    );
    onBeforeUnmount(() => emit('referenceStateChange', null));

    function handleResultClick(index: number) {
        if (props.referenceMode) {
            if (getReferenceCandidate(index)) emit('reference', index);
            return;
        }
        void handleItemClick(index);
    }

    function assignScrollRef(element: HTMLElement | null) {
        scrollRef.value = element;
    }

    function assignItemRef(element: Element | ComponentPublicInstance | null, index: number) {
        const dom = element instanceof Element ? element : element?.$el;
        if (dom instanceof HTMLElement) itemRefs.value[index] = dom;
    }

    function handleBlankSurfaceClick() {
        emit('blankClick');
    }

    const panelState = computed<ResultPanelState | null>(() => {
        if (results.value.length) return null;
        if (searchState.value === 'loading')
            return { kind: 'loading', message: t('search.results.fileLoading') };
        if (searchState.value === 'ready')
            return { kind: 'empty', message: t('search.results.fileEmpty') };
        if (searchState.value === 'error')
            return { kind: 'error', message: t('search.results.fileError') };
        return null;
    });
    const statusGroups = computed(() => {
        if (!results.value.length) return [];
        const total = totalResults.value;
        const totalPages = Math.max(1, Math.ceil(total / 60));
        const totalLabel = t('quickSearch.status.total', { total });
        if (totalPages === 1) return [totalLabel];
        const currentPageNum =
            highlightedIndex.value >= 0
                ? Math.floor(highlightedIndex.value / 60) + 1
                : currentPage.value + 1;
        return [t('quickSearch.status.page', { current: currentPageNum, totalPages }), totalLabel];
    });
    const shortcuts = computed<ResultPanelShortcut[]>(() => {
        if (!results.value.length) return [];
        if (props.referenceMode) {
            const items: ResultPanelShortcut[] = [
                {
                    keys: highlightedIndex.value < 0 ? ['↓'] : ['↑', '↓'],
                    label: t('search.results.navigate'),
                },
            ];
            if (highlightedIndex.value >= 0)
                items.push({
                    keys: ['Enter', 'Tab'],
                    separator: '/',
                    label: t('search.results.reference'),
                });
            items.push({ keys: ['Esc'], label: t('search.results.close') });
            return items;
        }
        if (highlightedIndex.value < 0) {
            return [{ keys: ['↓'], label: t('search.results.navigate') }];
        }
        const hints: ResultPanelShortcut[] = [
            { keys: ['↑', '↓'], label: t('search.results.navigate') },
            { keys: ['Enter'], label: t('search.results.open') },
        ];
        if (
            results.value[highlightedIndex.value]?.result.completionAction?.kind ===
            'file.reference'
        )
            hints.push({ keys: ['Tab'], label: t('search.results.reference') });
        hints.push({ keys: ['Esc'], label: t('search.results.back') });
        return hints;
    });
    const viewToggleLabel = computed(() => {
        return viewMode.value === 'grid'
            ? t('quickSearch.view.switchToList')
            : t('quickSearch.view.switchToGrid');
    });
    const viewToggleKeys = computed(() => {
        const shortcut = settingsStore.searchKeybindings['search.quickSearch.toggleView'];
        return shortcut ? formatShortcutForDisplay(shortcut).split('+') : [];
    });

    defineExpose({
        getContentHeight: () => panel.value?.getContentHeight() ?? 0,
        open: openPanel,
        close: closePanel,
        settleInteraction,
        moveSelection,
        getHighlightedItem,
        getReferenceCandidate,
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
