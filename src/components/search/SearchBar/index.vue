<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div ref="containerRef" class="relative mx-auto h-full w-full select-none">
        <div
            class="search-bar-container relative flex h-full items-center gap-3 p-3 transition-all duration-250 ease-in-out"
            @mousedown="handleContainerMouseDown"
        >
            <div
                ref="logoContainerRef"
                class="logo-container flex cursor-pointer items-center justify-center"
                data-tauri-drag-region="false"
                @mousedown.stop.prevent="toggleModelDropdown"
            >
                <ModelLogo
                    v-if="selectedModelId || activeModel"
                    :model-id="selectedModelId || activeModel?.model_id || ''"
                    :name="selectedModelName || activeModel?.name || 'model'"
                    class="border-2 border-gray-300 transition-colors hover:border-gray-400"
                />
                <img v-else :src="logoWord" alt="search" class="h-8 w-15 select-none" />
            </div>

            <div
                v-if="selectedModelId"
                class="inline-flex items-center gap-1.5 rounded-md bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700"
            >
                <span>@{{ selectedModelName }}</span>
                <button
                    class="rounded p-0.5 transition-colors hover:bg-blue-200"
                    @click.stop="clearSelectedModel"
                >
                    <SvgIcon name="x" class="h-3 w-3" />
                </button>
            </div>

            <input
                ref="searchInput"
                v-model="searchQuery"
                type="text"
                autofocus
                :readonly="disabled"
                :placeholder="currentPlaceholder"
                :class="[
                    'flex-1 cursor-default border-0 bg-transparent font-sans text-lg caret-gray-500 outline-none placeholder:text-gray-400 placeholder:select-none',
                    disabled ? 'text-gray-400' : 'text-gray-900',
                ]"
                @input="onInput"
                @mousedown="handleInputMouseDown"
            />

            <AttachmentList
                :attachments="attachments"
                @remove="removeAttachment"
                @preview="previewAttachment"
                @focus-search-bar="focus"
            />
        </div>

        <QuickSearchPanel
            ref="quickSearchPanel"
            :search-query="searchQuery"
            :enabled="quickSearchEnabled && !isModelDropdownOpen"
        />
    </div>
</template>

<script setup lang="ts">
    import logoWord from '@assets/logo-word.svg';
    import ModelLogo from '@components/common/ModelLogo.vue';
    import SvgIcon from '@components/common/SvgIcon.vue';
    import AttachmentList from '@components/search/AttachmentList.vue';
    import QuickSearchPanel from '@components/search/QuickSearchPanel/index.vue';
    import type { Index } from '@services/AiService/attachments';
    import { toRef, toRefs } from 'vue';

    import { type ModelCapabilities, useSearchInput } from './useSearchLogic';

    defineOptions({
        name: 'SearchBar',
    });

    interface Props {
        disabled?: boolean;
        attachments?: Index[];
        quickSearchEnabled?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        disabled: false,
        attachments: () => [],
        quickSearchEnabled: true,
    });

    const { disabled, attachments, quickSearchEnabled } = toRefs(props);

    const emit = defineEmits<{
        search: [query: string];
        submit: [query: string];
        clear: [];
        modelChange: [capabilities: ModelCapabilities];
        removeAttachment: [id: string];
        dragStart: [];
        dragEnd: [];
    }>();

    const {
        logoContainerRef,
        quickSearchPanel,
        searchQuery,
        searchInput,
        currentPlaceholder,
        selectedModelId,
        selectedModelName,
        selectedProviderId,
        activeModel,
        isModelDropdownOpen,
        isQuickSearchOpen,
        isAnyDropdownOpen,
        toggleModelDropdown,
        closeModelDropdown,
        hideAllDropdowns,
        openModelDropdown,
        clearSelectedModel,
        openQuickSearchPanel,
        closeQuickSearchPanel,
        moveQuickSearchSelection,
        getHighlightedQuickShortcut,
        openHighlightedQuickShortcut,
        onInput,
        removeAttachment,
        previewAttachment,
        clearInput,
        isCursorAtStart,
        focus,
        loadActiveModel,
        handleContainerMouseDown,
        handleInputMouseDown,
    } = useSearchInput({
        quickSearchEnabled: toRef(props, 'quickSearchEnabled'),
        emitSearch: (query) => emit('search', query),
        emitModelChange: (capabilities) => emit('modelChange', capabilities),
        emitRemoveAttachment: (id) => emit('removeAttachment', id),
        emitDragStart: () => emit('dragStart'),
        emitDragEnd: () => emit('dragEnd'),
    });

    defineExpose({
        selectedModelId,
        selectedProviderId,
        isModelDropdownOpen,
        isQuickSearchOpen,
        isAnyDropdownOpen,
        clearSelectedModel,
        closeModelDropdown,
        closeQuickSearchPanel,
        hideAllDropdowns,
        openModelDropdown,
        openQuickSearchPanel,
        moveQuickSearchSelection,
        getHighlightedQuickShortcut,
        openHighlightedQuickShortcut,
        focus,
        clearInput,
        loadActiveModel,
        isCursorAtStart,
    });
</script>

<style scoped src="./style.css"></style>
