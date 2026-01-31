<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div ref="containerRef" class="relative mx-auto h-[56px] w-full select-none">
        <div
            :class="[
                'search-bar-container bg-background-primary relative flex h-full items-center gap-3 rounded-lg p-3 backdrop-blur-xl transition-all duration-250 ease-in-out',
                isLoading ? 'loading' : '',
            ]"
        >
            <div
                class="flex cursor-pointer items-center justify-center"
                data-tauri-drag-region="false"
            >
                <img
                    v-if="selectedModelId || activeModel"
                    :src="getModelLogoPath(selectedModelId || activeModel?.model_id || '')"
                    :alt="selectedModelName || activeModel?.name || 'model'"
                    class="h-8 w-8 rounded-full border-2 border-gray-300 transition-colors hover:border-gray-400"
                    data-tauri-drag-region="false"
                    @click.stop="toggleModelDropdown"
                />
                <img
                    v-else
                    :src="logoWord"
                    alt="search"
                    class="h-5 w-15 select-none"
                    data-tauri-drag-region="false"
                    @click.stop="toggleModelDropdown"
                />
            </div>

            <div
                v-if="selectedModelId"
                class="inline-flex items-center gap-1.5 rounded-md bg-blue-100 px-2 py-1 text-sm font-medium text-blue-700"
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
            />

            <div
                v-if="searchQuery"
                class="ml-2 flex cursor-pointer items-center text-gray-400 transition-colors duration-200 hover:text-gray-600"
                data-tauri-drag-region="false"
                @click.stop="clearSearch"
            >
                <SvgIcon name="clear" class="h-5 w-5" />
            </div>
        </div>

        <ModelDropdown
            ref="modelDropdownRef"
            :is-open="isModelDropdownOpen"
            :active-model-id="activeModel?.model_id || ''"
            :search-query="dropdownSearchQuery"
            @select="handleModelSelect"
            @close="closeModelDropdown"
        />
    </div>
</template>

<script setup lang="ts">
    // Copyright (c) 2025. 千诚. Licensed under GPL v3.

    import logoWord from '@assets/logo_word.svg';
    import SvgIcon from '@components/common/SvgIcon.vue';
    import ModelDropdown from '@components/search/ModelDropdown.vue';
    import { findModelsWithProvider } from '@database/queries';
    import type { ModelWithProvider } from '@services/ai/manager';
    import { aiService } from '@services/ai/manager';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { getModelLogoByModelName } from '@utils/modelLogoMatcher';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    interface Props {
        disabled?: boolean;
        isLoading?: boolean;
    }

    withDefaults(defineProps<Props>(), {
        disabled: false,
        isLoading: false,
    });

    const placeholder = '写下你的需求...';

    const searchQuery = ref('');
    const searchInput = ref<HTMLInputElement | null>(null);
    const modelDropdownRef = ref<InstanceType<typeof ModelDropdown> | null>(null);
    const containerRef = ref<HTMLElement | null>(null);

    // 保存打开下拉框前的状态
    const savedSearchQuery = ref('');
    const savedCursorPosition = ref(0);
    const isSearchingModel = ref(false);

    // 动态 placeholder
    const currentPlaceholder = computed(() => {
        return isSearchingModel.value ? '请输入模型名称或ID' : placeholder;
    });

    // Model selection state
    const selectedModelId = ref<string | null>(null);
    const selectedModelName = ref<string | null>(null);
    const selectedProviderId = ref<number | null>(null); // 添加 provider_id
    const activeModel = ref<ModelWithProvider | null>(null);
    const isModelDropdownOpen = ref(false);
    const dropdownSearchQuery = ref('');

    const emit = defineEmits<{
        search: [query: string];
        submit: [query: string];
        clear: [];
        dropdownStateChange: [isOpen: boolean];
    }>();

    // 加载活动模型
    const loadActiveModel = async () => {
        try {
            activeModel.value = await aiService.getActiveModel();
        } catch (error) {
            console.error('[SearchBar] Failed to load active model:', error);
        }
    };

    // Load active model on mount
    onMounted(async () => {
        await loadActiveModel();

        // 添加全局点击事件监听，点击外部关闭下拉框
        document.addEventListener('click', handleClickOutside);

        // 监听窗口焦点事件，每次获得焦点时重新加载活动模型
        getCurrentWindow().listen('tauri://focus', async () => {
            await loadActiveModel();
        });
    });

    onUnmounted(() => {
        // 清理事件监听
        document.removeEventListener('click', handleClickOutside);
    });

    // 点击外部关闭下拉框
    function handleClickOutside(event: MouseEvent) {
        if (!isModelDropdownOpen.value) return;

        const target = event.target as Node;
        // 如果点击的不是容器内的元素，关闭下拉框
        if (containerRef.value && !containerRef.value.contains(target)) {
            closeModelDropdown();
        }
    }

    function getModelLogoPath(modelId: string): string {
        const logo = getModelLogoByModelName(modelId);
        return logo ? `/src/assets/logos/models/${logo}` : logoWord;
    }

    function toggleModelDropdown() {
        if (!isModelDropdownOpen.value) {
            // 打开下拉框：保存当前状态，清空输入框
            savedSearchQuery.value = searchQuery.value;
            savedCursorPosition.value = searchInput.value?.selectionStart || 0;
            searchQuery.value = '';
            isSearchingModel.value = true;
            dropdownSearchQuery.value = '';
            isModelDropdownOpen.value = true;
            // 确保输入框保持焦点
            searchInput.value?.focus();
        } else {
            // 关闭下拉框：恢复原始状态
            isModelDropdownOpen.value = false;
            dropdownSearchQuery.value = '';
            restoreSearchState();
        }
        emit('dropdownStateChange', isModelDropdownOpen.value);
    }

    function closeModelDropdown() {
        isModelDropdownOpen.value = false;
        dropdownSearchQuery.value = '';
        restoreSearchState();
        emit('dropdownStateChange', false);
    }

    // 恢复搜索框状态
    function restoreSearchState() {
        if (isSearchingModel.value) {
            searchQuery.value = savedSearchQuery.value;
            isSearchingModel.value = false;
            // 恢复光标位置
            setTimeout(() => {
                if (searchInput.value) {
                    searchInput.value.setSelectionRange(
                        savedCursorPosition.value,
                        savedCursorPosition.value
                    );
                    searchInput.value.focus();
                }
            }, 0);
        }
    }

    async function handleModelSelect(modelDbId: number) {
        try {
            const models = await findModelsWithProvider();
            const model = models.find((m) => m.id === modelDbId);
            if (model) {
                selectedModelId.value = model.model_id;
                selectedModelName.value = model.name;
                selectedProviderId.value = model.provider_id;
            }
        } catch (error) {
            console.error('[SearchBar] Failed to select model:', error);
        }
        // 关闭下拉框并恢复输入框状态
        isModelDropdownOpen.value = false;
        dropdownSearchQuery.value = '';
        restoreSearchState();
        emit('dropdownStateChange', false);
    }

    function clearSelectedModel() {
        selectedModelId.value = null;
        selectedModelName.value = null;
        selectedProviderId.value = null;
    }

    function onInput() {
        // 如果下拉框打开，输入内容用于搜索模型
        if (isModelDropdownOpen.value) {
            dropdownSearchQuery.value = searchQuery.value;
        }
        emit('search', searchQuery.value);
    }

    // 打开模型下拉框
    function openModelDropdown() {
        savedSearchQuery.value = searchQuery.value;
        savedCursorPosition.value = searchInput.value?.selectionStart || 0;
        searchQuery.value = '';
        isSearchingModel.value = true;
        dropdownSearchQuery.value = '';
        isModelDropdownOpen.value = true;
        emit('dropdownStateChange', true);
        searchInput.value?.focus();
    }

    // 处理下拉框的键盘事件
    function handleDropdownKeyDown(event: KeyboardEvent) {
        modelDropdownRef.value?.handleKeyDown(event);
    }

    function clearSearch() {
        searchQuery.value = '';
        emit('clear');
    }

    function clearInput() {
        searchQuery.value = '';
    }

    async function focus() {
        searchInput?.value?.focus();
    }

    defineExpose({
        selectedModelId,
        selectedProviderId,
        isModelDropdownOpen,
        clearSelectedModel,
        closeModelDropdown,
        openModelDropdown,
        handleDropdownKeyDown,
        focus,
        clearInput,
    });
</script>

<style scoped>
    .search-bar-container {
        border: 1.5px solid #d1d5db;
    }

    @keyframes border-flow {
        0% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899, #8b5cf6, #3b82f6);
        }
        25% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #8b5cf6, #ec4899, #8b5cf6, #3b82f6, #8b5cf6);
        }
        50% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #ec4899, #8b5cf6, #3b82f6, #8b5cf6, #ec4899);
        }
        75% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #8b5cf6, #3b82f6, #8b5cf6, #ec4899, #8b5cf6);
        }
        100% {
            background-image:
                linear-gradient(rgba(251, 251, 246, 0.98), rgba(251, 251, 246, 0.98)),
                linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899, #8b5cf6, #3b82f6);
        }
    }
</style>
