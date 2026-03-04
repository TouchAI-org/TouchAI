import { findModelsWithProvider } from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import { aiService } from '@services/AiService';
import { type ModelDropdownPopupItem, popupManager } from '@services/PopupService';
import { computed, onMounted, onUnmounted, type Ref, ref } from 'vue';

export interface ModelCapabilities {
    supportsImages: boolean;
    supportsFiles: boolean;
}

interface UseModelSelectionOptions {
    searchQuery: Ref<string>;
    searchInput: Ref<HTMLInputElement | null>;
    logoContainerRef: Ref<HTMLElement | null>;
    closeQuickSearchPanel: () => void;
}

export interface UseModelSelectionDeps {
    findModels: () => Promise<ModelWithProvider[]>;
    getActiveModel: () => Promise<ModelWithProvider | null>;
    popup: Pick<typeof popupManager, 'state' | 'toggle' | 'hide' | 'updateData' | 'listen'>;
}

const DEFAULT_DEPS: UseModelSelectionDeps = {
    findModels: () => findModelsWithProvider(),
    getActiveModel: () => aiService.getModel(),
    popup: popupManager,
};

/**
 * 模型选择流程。
 * 负责模型下拉开关、模型覆盖选择、输入状态恢复与能力计算。
 *
 * @param options 模型选择依赖项与外部协作回调。
 * @param deps 可注入模型服务与弹窗管理依赖。
 * @returns 模型展示状态、能力计算结果与下拉控制方法。
 */
export function useModelSelection(
    options: UseModelSelectionOptions,
    deps: UseModelSelectionDeps = DEFAULT_DEPS
) {
    const { searchQuery, searchInput, logoContainerRef, closeQuickSearchPanel } = options;
    const placeholder = '写下你的需求...';

    // 1. 搜索上下文缓存
    // 保存打开下拉框前的状态
    const savedSearchQuery = ref('');
    const savedCursorPosition = ref(0);
    const isSearchingModel = ref(false);

    // 2. 占位提示与模型状态
    // 动态占位提示
    const currentPlaceholder = computed(() => {
        return isSearchingModel.value ? '请输入模型名称或ID' : placeholder;
    });

    // 模型选择状态
    const selectedModelId = ref<string | null>(null);
    const selectedModelName = ref<string | null>(null);
    const selectedProviderId = ref<number | null>(null);
    const activeModel = ref<ModelWithProvider | null>(null);
    const selectedModel = ref<ModelWithProvider | null>(null);
    const popupModels = ref<ModelDropdownPopupItem[]>([]);
    const isModelDropdownOpen = ref(false);
    const dropdownSearchQuery = ref('');
    const isPopupOpen = computed(() => deps.popup.state.isOpen);

    // 3. 当前活动模型加载
    /**
     * 加载当前活动模型，供默认展示与能力判断使用。
     *
     * @returns Promise<void>
     */
    async function loadActiveModel() {
        try {
            activeModel.value = await deps.getActiveModel();
        } catch (error) {
            console.error('[SearchBar] Failed to load active model:', error);
            activeModel.value = null;
        }
    }

    function mapPopupModel(model: ModelWithProvider): ModelDropdownPopupItem {
        return {
            id: model.id,
            modelId: model.model_id,
            name: model.name,
            providerId: model.provider_id,
            providerName: model.provider_name,
            reasoning: model.reasoning,
            tool_call: model.tool_call,
            modalities: model.modalities,
            attachment: model.attachment,
            open_weights: model.open_weights,
        };
    }

    async function loadPopupModels() {
        try {
            const models = await deps.findModels();
            popupModels.value = models.filter((m) => m.provider_enabled === 1).map(mapPopupModel);
        } catch (error) {
            console.error('[SearchBar] Failed to load popup models:', error);
            popupModels.value = [];
        }
    }

    // 清理函数引用
    let cleanupFn: (() => void) | null = null;

    // 4. 输入状态恢复与下拉状态收敛
    /**
     * 退出模型搜索模式时，恢复原输入内容与光标位置。
     *
     * @returns void
     */
    function restoreSearchState() {
        if (isSearchingModel.value) {
            searchQuery.value = savedSearchQuery.value;
            isSearchingModel.value = false;
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

    /**
     * 重置模型下拉相关状态，统一关闭路径。
     *
     * @returns void
     */
    function resetModelDropdownState() {
        // 收敛所有下拉状态，保证关闭路径统一。
        isModelDropdownOpen.value = false;
        dropdownSearchQuery.value = '';
        restoreSearchState();
    }

    // 5. 下拉开关与模型选择
    /**
     * 切换模型下拉框的显示状态。
     *
     * @returns Promise<void>
     */
    async function toggleModelDropdown() {
        if (!logoContainerRef.value) return;
        // 模型下拉与快速搜索互斥，避免遮挡和键盘焦点冲突。
        closeQuickSearchPanel();

        const wasOpen = isModelDropdownOpen.value;

        try {
            if (!wasOpen) {
                await loadPopupModels();
            }

            await deps.popup.toggle('model-dropdown-popup', logoContainerRef.value, {
                activeModelId: activeModel.value?.model_id || '',
                activeProviderId: activeModel.value?.provider_id ?? null,
                selectedModelId: selectedModelId.value || '',
                selectedProviderId: selectedProviderId.value ?? null,
                searchQuery: dropdownSearchQuery.value,
                models: popupModels.value,
            });

            if (!wasOpen) {
                // 进入“模型搜索模式”前先保存用户原查询与光标。
                savedSearchQuery.value = searchQuery.value;
                savedCursorPosition.value = searchInput.value?.selectionStart || 0;
                searchQuery.value = '';
                isSearchingModel.value = true;
                dropdownSearchQuery.value = '';
                isModelDropdownOpen.value = true;

                setTimeout(() => {
                    searchInput.value?.focus();
                }, 100);
            } else {
                resetModelDropdownState();
            }
        } catch (error) {
            console.error('[SearchBar] Failed to toggle popup:', error);
            resetModelDropdownState();
        }
    }

    /**
     * 关闭模型下拉框。
     *
     * @returns Promise<void>
     */
    async function closeModelDropdown() {
        if (!isModelDropdownOpen.value) return;

        try {
            await deps.popup.hide();
            resetModelDropdownState();
        } catch (error) {
            console.error('[SearchBar] Failed to close popup:', error);
        }
    }

    /**
     * 打开模型下拉框，并进入模型搜索输入模式。
     *
     * @returns Promise<void>
     */
    async function openModelDropdown() {
        if (!logoContainerRef.value) return;
        closeQuickSearchPanel();
        await loadPopupModels();

        // 与 toggle 的打开分支保持一致，确保外部直接调用行为相同。
        savedSearchQuery.value = searchQuery.value;
        savedCursorPosition.value = searchInput.value?.selectionStart || 0;
        searchQuery.value = '';
        isSearchingModel.value = true;
        dropdownSearchQuery.value = '';
        isModelDropdownOpen.value = true;

        try {
            await deps.popup.toggle('model-dropdown-popup', logoContainerRef.value, {
                activeModelId: activeModel.value?.model_id || '',
                activeProviderId: activeModel.value?.provider_id ?? null,
                selectedModelId: selectedModelId.value || '',
                selectedProviderId: selectedProviderId.value ?? null,
                searchQuery: dropdownSearchQuery.value,
                models: popupModels.value,
            });
        } catch (error) {
            console.error('[SearchBar] Failed to open popup:', error);
            resetModelDropdownState();
        }

        setTimeout(() => {
            searchInput.value?.focus();
        }, 100);
    }

    /**
     * 处理模型选择，支持“再次选择默认模型=取消覆盖”逻辑。
     *
     * @param modelDbId 模型数据库主键 ID。
     * @returns Promise<void>
     */
    async function handleModelSelect(modelDbId: number) {
        try {
            const models = await deps.findModels();
            const model = models.find((m) => m.id === modelDbId);
            if (model) {
                // 再次选择当前默认模型视为“取消覆盖”，恢复跟随全局模型。
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

    /**
     * 清除手动选择模型，恢复跟随当前活动模型。
     *
     * @returns void
     */
    function clearSelectedModel() {
        selectedModel.value = null;
        selectedModelId.value = null;
        selectedModelName.value = null;
        selectedProviderId.value = null;
    }

    // 6. 模型能力计算
    /**
     * 解析模型模态配置，异常时退化为纯文本输入输出。
     *
     * @param modalities 模型模态配置 JSON 字符串。
     * @returns 解析后的输入/输出模态集合。
     */
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

    /**
     * 同步模型下拉搜索词到 popup data，驱动弹窗过滤。
     *
     * @param query 下拉过滤查询。
     * @returns void
     */
    function updateDropdownSearchQuery(query: string) {
        dropdownSearchQuery.value = query;
        // 弹窗内容由 popupManager 管理，输入时同步更新上下文数据。
        deps.popup.updateData({
            activeModelId: activeModel.value?.model_id || '',
            activeProviderId: activeModel.value?.provider_id ?? null,
            selectedModelId: selectedModelId.value || '',
            selectedProviderId: selectedProviderId.value ?? null,
            searchQuery: dropdownSearchQuery.value,
            models: popupModels.value,
        });
    }

    // 7. 生命周期注册
    onMounted(async () => {
        await Promise.all([loadActiveModel(), loadPopupModels()]);

        cleanupFn = await deps.popup.listen({
            onModelSelect: handleModelSelect,
            onClose: () => {
                resetModelDropdownState();
            },
        });
    });

    onUnmounted(() => {
        if (cleanupFn) {
            cleanupFn();
        }
    });

    return {
        currentPlaceholder,
        selectedModelId,
        selectedModelName,
        selectedProviderId,
        activeModel,
        isModelDropdownOpen,
        isPopupOpen,
        isSearchingModel,
        modelCapabilities,
        popupModels,
        dropdownSearchQuery,
        loadActiveModel,
        toggleModelDropdown,
        closeModelDropdown,
        openModelDropdown,
        clearSelectedModel,
        updateDropdownSearchQuery,
        restoreSearchState,
        resetModelDropdownState,
    };
}
