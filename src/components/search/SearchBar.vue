<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div ref="containerRef" class="relative mx-auto h-full w-full select-none">
        <div
            class="search-bar-container relative flex h-full items-center gap-3 p-3 transition-all duration-250 ease-in-out"
            data-tauri-drag-region
            @mousedown="handleContainerMouseDown"
        >
            <div
                ref="logoContainerRef"
                class="logo-container flex cursor-pointer items-center justify-center"
                @click.stop.prevent="toggleModelDropdown"
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
    </div>
</template>

<script setup lang="ts">
    // Copyright (c) 2025. 千诚. Licensed under GPL v3.
    import logoWord from '@assets/logo_word.svg';
    import ModelLogo from '@components/common/ModelLogo.vue';
    import SvgIcon from '@components/common/SvgIcon.vue';
    import AttachmentList from '@components/search/AttachmentList.vue';
    import { findModelsWithProvider } from '@database/queries';
    import type { ModelWithProviderAndMetadata } from '@database/queries/models';
    import { aiService } from '@services/ai/manager';
    import { popupManager } from '@services/popup';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
    import type { Attachment } from '@utils/attachment.ts';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    interface ModelCapabilities {
        supportsImages: boolean;
        supportsFiles: boolean;
    }

    interface Props {
        disabled?: boolean;
        attachments?: Attachment[];
    }

    const { disabled = false, attachments = [] } = defineProps<Props>();

    const placeholder = '写下你的需求...';

    const searchQuery = ref('');
    const searchInput = ref<HTMLInputElement | null>(null);
    const containerRef = ref<HTMLElement | null>(null);
    const logoContainerRef = ref<HTMLElement | null>(null);

    // Popup window integration
    const isPopupOpen = computed(() => popupManager.state.isOpen);

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
    const activeModel = ref<ModelWithProviderAndMetadata | null>(null);
    const selectedModel = ref<ModelWithProviderAndMetadata | null>(null);
    const isModelDropdownOpen = ref(false);
    const dropdownSearchQuery = ref('');

    const emit = defineEmits<{
        search: [query: string];
        submit: [query: string];
        clear: [];
        modelChange: [capabilities: ModelCapabilities];
        removeAttachment: [id: string];
        dragStart: [];
        dragEnd: [];
    }>();

    // 加载活动模型
    const loadActiveModel = async () => {
        try {
            activeModel.value =
                (await aiService.getActiveModel()) as ModelWithProviderAndMetadata | null;
        } catch (error) {
            console.error('[SearchBar] Failed to load active model:', error);
        }
    };

    // 清理函数引用
    let cleanupFn: (() => void) | null = null;

    onMounted(async () => {
        await loadActiveModel();

        cleanupFn = await popupManager.listen({
            onModelSelect: handleModelSelect,
            onClose: () => {
                isModelDropdownOpen.value = false;
                dropdownSearchQuery.value = '';
                restoreSearchState();
            },
        });
    });

    onUnmounted(() => {
        if (cleanupFn) {
            cleanupFn();
        }
    });

    async function toggleModelDropdown() {
        if (!logoContainerRef.value) return;

        // 在调用 toggle 之前记录当前状态，用于判断是打开还是关闭操作
        const wasOpen = isModelDropdownOpen.value;

        try {
            // toggle 会自动处理开关逻辑，添加超时保护
            await popupManager.toggle('model-dropdown-popup', logoContainerRef.value, {
                activeModelId: activeModel.value?.model_id || '',
                activeProviderId: activeModel.value?.provider_id ?? null,
                selectedModelId: selectedModelId.value || '',
                selectedProviderId: selectedProviderId.value ?? null,
                searchQuery: dropdownSearchQuery.value,
            });

            // 根据之前的状态判断是打开还是关闭操作
            if (!wasOpen) {
                // 弹窗打开：保存当前状态，清空输入框
                savedSearchQuery.value = searchQuery.value;
                savedCursorPosition.value = searchInput.value?.selectionStart || 0;
                searchQuery.value = '';
                isSearchingModel.value = true;
                dropdownSearchQuery.value = '';
                isModelDropdownOpen.value = true;

                // 延迟聚焦，确保弹窗完全显示后输入框能获得焦点
                setTimeout(() => {
                    searchInput.value?.focus();
                }, 100);
            } else {
                // 弹窗关闭：恢复搜索状态
                isModelDropdownOpen.value = false;
                dropdownSearchQuery.value = '';
                restoreSearchState();
            }
        } catch (error) {
            console.error('[SearchBar] Failed to toggle popup:', error);
            isModelDropdownOpen.value = false;
            restoreSearchState();
        }
    }

    async function closeModelDropdown() {
        if (!isModelDropdownOpen.value) return;

        try {
            await popupManager.hide();
            isModelDropdownOpen.value = false;
            dropdownSearchQuery.value = '';
            restoreSearchState();
        } catch (error) {
            console.error('[SearchBar] Failed to close popup:', error);
        }
    }

    async function hideAllDropdowns() {
        if (!isPopupOpen.value && !isModelDropdownOpen.value && !isSearchingModel.value) {
            return;
        }

        try {
            await popupManager.hide();
        } catch (error) {
            console.error('[SearchBar] Failed to hide dropdown popups before dragging:', error);
        } finally {
            isModelDropdownOpen.value = false;
            dropdownSearchQuery.value = '';
            restoreSearchState();
        }
    }

    function isAnyDropdownOpen() {
        return isPopupOpen.value || isModelDropdownOpen.value || isSearchingModel.value;
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
                const isDefaultModel =
                    model.model_id === activeModel.value?.model_id &&
                    model.provider_id === activeModel.value?.provider_id;
                if (isDefaultModel) {
                    clearSelectedModel();
                } else {
                    selectedModel.value = model;
                    selectedModelId.value = model.model_id;
                    selectedModelName.value = model.name;
                    selectedProviderId.value = model.provider_id;
                }
            }
        } catch (error) {
            console.error('[SearchBar] Failed to select model:', error);
        }

        // 先恢复搜索状态，再关闭下拉框
        if (isSearchingModel.value) {
            searchQuery.value = savedSearchQuery.value;
        }

        // 关闭下拉框
        await closeModelDropdown();
    }

    function clearSelectedModel() {
        selectedModel.value = null;
        selectedModelId.value = null;
        selectedModelName.value = null;
        selectedProviderId.value = null;
    }

    function parseModalities(modalities?: string | null) {
        if (!modalities) return { input: ['text'], output: ['text'] };
        try {
            return JSON.parse(modalities) as { input?: string[]; output?: string[] };
        } catch (error) {
            console.warn('[SearchBar] Failed to parse model modalities:', error);
            return { input: ['text'], output: ['text'] };
        }
    }

    const currentModel = computed(() => selectedModel.value || activeModel.value);

    const modelCapabilities = computed<ModelCapabilities>(() => {
        const model = currentModel.value;
        if (!model) {
            return { supportsImages: false, supportsFiles: false };
        }
        const modalities = parseModalities(model.modalities);
        return {
            supportsImages: Boolean(modalities.input?.includes('image')),
            supportsFiles: model.attachment === 1,
        };
    });

    watch(
        modelCapabilities,
        (capabilities) => {
            emit('modelChange', capabilities);
        },
        { immediate: true }
    );

    function onInput() {
        // 如果下拉框打开，输入内容用于搜索模型，不触发搜索事件
        if (isModelDropdownOpen.value) {
            dropdownSearchQuery.value = searchQuery.value;
            // 更新弹窗的搜索查询
            popupManager.updateData({
                activeModelId: activeModel.value?.model_id || '',
                activeProviderId: activeModel.value?.provider_id ?? null,
                selectedModelId: selectedModelId.value || '',
                selectedProviderId: selectedProviderId.value ?? null,
                searchQuery: dropdownSearchQuery.value,
            });
            return; // 不触发搜索事件
        }
        emit('search', searchQuery.value);
    }

    // 打开模型下拉框
    async function openModelDropdown() {
        if (!logoContainerRef.value) return;

        savedSearchQuery.value = searchQuery.value;
        savedCursorPosition.value = searchInput.value?.selectionStart || 0;
        searchQuery.value = '';
        isSearchingModel.value = true;
        dropdownSearchQuery.value = '';
        isModelDropdownOpen.value = true;

        try {
            await popupManager.toggle('model-dropdown-popup', logoContainerRef.value, {
                activeModelId: activeModel.value?.model_id || '',
                activeProviderId: activeModel.value?.provider_id ?? null,
                selectedModelId: selectedModelId.value || '',
                selectedProviderId: selectedProviderId.value ?? null,
                searchQuery: dropdownSearchQuery.value,
            });
        } catch (error) {
            console.error('[SearchBar] Failed to open popup:', error);
            isModelDropdownOpen.value = false;
            restoreSearchState();
        }

        // 延迟聚焦，确保弹窗完全显示后输入框能获得焦点
        setTimeout(() => {
            searchInput.value?.focus();
        }, 100);
    }

    function removeAttachment(id: string) {
        emit('removeAttachment', id);
    }

    async function previewAttachment(attachment: Attachment) {
        if (attachment.type === 'image') {
            await openPath(attachment.path);
        } else {
            await revealItemInDir(attachment.path);
        }
    }

    function clearInput() {
        searchQuery.value = '';
    }

    function isCursorAtStart(): boolean {
        const input = searchInput.value;
        if (!input) return false;
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? start;
        return start === 0 && end === 0;
    }

    async function focus() {
        searchInput?.value?.focus();
    }

    // 处理容器的 mousedown 事件，空白区域支持拖动
    async function handleContainerMouseDown(event: MouseEvent) {
        const target = event.target as HTMLElement;

        // 如果点击的是 logo 容器或其子元素，不处理拖动
        const logoContainer = target.closest('.logo-container');
        if (logoContainer) {
            return;
        }

        // 如果点击的是容器本身（空白区域），启动拖动
        if (target.hasAttribute('data-tauri-drag-region')) {
            emit('dragStart');
            try {
                await getCurrentWindow().startDragging();
            } finally {
                // 延迟清除拖动状态，避免拖动结束时立即触发失焦隐藏
                setTimeout(() => {
                    emit('dragEnd');
                }, 100);
            }
        }
    }

    // 处理 input 的 mousedown 事件
    async function handleInputMouseDown(event: MouseEvent) {
        const input = searchInput.value;
        if (!input) return;

        // 如果 input 为空（显示 placeholder），整个区域都支持拖动
        if (!input.value) {
            event.preventDefault();
            emit('dragStart');
            try {
                await getCurrentWindow().startDragging();
            } finally {
                // 延迟清除拖动状态，避免拖动结束时立即触发失焦隐藏
                setTimeout(() => {
                    emit('dragEnd');
                }, 100);
            }
            return;
        }

        // 获取点击位置相对于 input 的 x 坐标
        const rect = input.getBoundingClientRect();
        const clickX = event.clientX - rect.left;

        // 计算已输入文本的宽度
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // 获取 input 的计算样式
        const style = window.getComputedStyle(input);
        ctx.font = `${style.fontSize} ${style.fontFamily}`;
        const textWidth = ctx.measureText(input.value).width;

        // 如果点击位置在文本之后（空白区域），启动拖动
        // 添加一些 padding 容差
        const padding = 10;
        if (clickX > textWidth + padding) {
            event.preventDefault();
            emit('dragStart');
            try {
                await getCurrentWindow().startDragging();
            } finally {
                // 延迟清除拖动状态，避免拖动结束时立即触发失焦隐藏
                setTimeout(() => {
                    emit('dragEnd');
                }, 100);
            }
        }
    }

    defineExpose({
        selectedModelId,
        selectedProviderId,
        isModelDropdownOpen,
        isAnyDropdownOpen,
        clearSelectedModel,
        closeModelDropdown,
        hideAllDropdowns,
        openModelDropdown,
        focus,
        clearInput,
        loadActiveModel,
        isCursorAtStart,
    });
</script>
