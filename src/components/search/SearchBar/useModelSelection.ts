import { findModelsWithProvider } from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import { aiService } from '@services/AiService';
import { type ModelDropdownPopupItem, popupManager } from '@services/PopupService';
import type { Editor, JSONContent } from '@tiptap/core';
import { computed, onMounted, onUnmounted, type Ref, ref, type ShallowRef } from 'vue';

import { insertModelTag, removeModelTag } from './tags/model';
import { clearEditorSkipSync, DEFAULT_PLACEHOLDER, getEditorJSON, setEditorJSON } from './tiptap';

export interface ModelCapabilities {
    supportsImages: boolean;
    supportsFiles: boolean;
}

interface UseModelSelectionOptions {
    searchQuery: Ref<string>;
    editor: ShallowRef<Editor | null>;
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
    const { searchQuery, editor, logoContainerRef, closeQuickSearchPanel } = options;

    // 1. 搜索上下文缓存
    // 保存打开下拉框前的状态
    const savedEditorJSON = ref<JSONContent | null>(null);
    const isSearchingModel = ref(false);

    // 2. 占位提示与模型状态
    // 动态占位提示
    const currentPlaceholder = computed(() => {
        return isSearchingModel.value ? '请输入模型名称或ID' : DEFAULT_PLACEHOLDER;
    });

    // 模型选择状态
    const selectedModel = ref<ModelWithProvider | null>(null);
    const selectedModelId = computed(() => selectedModel.value?.model_id ?? null);
    const selectedModelName = computed(() => selectedModel.value?.name ?? null);
    const selectedProviderId = computed(() => selectedModel.value?.provider_id ?? null);
    const activeModel = ref<ModelWithProvider | null>(null);
    const popupModels = ref<ModelDropdownPopupItem[]>([]);
    // 缓存原始模型列表，供 handleModelSelect 使用，避免重复查询数据库。
    let cachedRawModels: ModelWithProvider[] = [];
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
            cachedRawModels = models;
            popupModels.value = models.filter((m) => m.provider_enabled === 1).map(mapPopupModel);
        } catch (error) {
            console.error('[SearchBar] Failed to load popup models:', error);
            cachedRawModels = [];
            popupModels.value = [];
        }
    }

    // 清理函数引用
    let cleanupFn: (() => void) | null = null;

    // 4. 输入状态恢复与下拉状态收敛
    /**
     * 退出模型搜索模式时，恢复原输入内容。
     *
     * @returns void
     */
    function restoreSearchState() {
        if (isSearchingModel.value) {
            const ed = editor.value;
            if (ed && savedEditorJSON.value) {
                setEditorJSON(ed, savedEditorJSON.value);
            } else {
                searchQuery.value = '';
            }
            isSearchingModel.value = false;
            savedEditorJSON.value = null;
            setTimeout(() => {
                editor.value?.commands.focus('end');
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

    /**
     * 进入模型搜索模式：保存编辑器内容、清空输入、切换状态。
     * 清空编辑器时通过 transaction meta 跳过 NodeSync 回调，
     * 避免 clearContent 移除 model tag 导致 syncSelectedModelCleared 误清选择状态。
     */
    function enterModelSearchMode() {
        const ed = editor.value;
        if (ed) {
            savedEditorJSON.value = getEditorJSON(ed);
            clearEditorSkipSync(ed);
        }
        searchQuery.value = '';
        isSearchingModel.value = true;
        dropdownSearchQuery.value = '';
        isModelDropdownOpen.value = true;

        setTimeout(() => {
            editor.value?.commands.focus();
        }, 100);
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
                enterModelSearchMode();
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

        enterModelSearchMode();

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
    }

    /**
     * 处理模型选择，支持"再次选择默认模型=取消覆盖"逻辑。
     *
     * @param modelDbId 模型数据库主键 ID。
     * @returns Promise<void>
     */
    async function handleModelSelect(modelDbId: number) {
        let modelToSelect: ModelWithProvider | null = null;
        let shouldClearModel = false;

        const model = cachedRawModels.find((m) => m.id === modelDbId);
        if (model) {
            // 再次选择当前默认模型视为"取消覆盖"，恢复跟随全局模型。
            const isDefaultModel =
                model.model_id === activeModel.value?.model_id &&
                model.provider_id === activeModel.value?.provider_id;
            if (isDefaultModel) {
                shouldClearModel = true;
            } else {
                modelToSelect = model;
            }
        }

        // 先关闭下拉状态，再恢复编辑器内容。
        // 顺序至关重要：setEditorJSON 会同步触发 onUpdate → onInput()，
        // 若 isModelDropdownOpen 仍为 true，onInput 会调用 updateDropdownSearchQuery
        // → popup.updateData() → 向弹窗窗口发送 popup-data 事件。
        // 该事件与随后的 popup-closed 事件跨窗口交付顺序不确定，
        // 若 popup-data 晚于 popup-closed 到达，会导致已关闭的弹窗被重新显示。
        const wasSearching = isSearchingModel.value;
        const savedJSON = savedEditorJSON.value;
        isSearchingModel.value = false;
        isModelDropdownOpen.value = false;
        dropdownSearchQuery.value = '';
        savedEditorJSON.value = null;

        // 恢复编辑器内容（此时 isModelDropdownOpen=false，onInput 不会向 popup 发送数据更新）
        if (wasSearching && savedJSON) {
            const ed = editor.value;
            if (ed) {
                setEditorJSON(ed, savedJSON);
            }
        }

        try {
            await deps.popup.hide();
        } catch {
            // 弹窗可能已被其他路径关闭，忽略错误。
        }

        // 编辑器内容已恢复，此时再执行标签操作才能正确找到/修改节点。
        // clearSelectedModel 必须在 setEditorJSON 之后调用：
        // enterModelSearchMode 的 clearContent 清空了编辑器，
        // 若在恢复前调用 removeModelTag，编辑器为空找不到标签，
        // 恢复后旧快照中的 model tag 又会被原样带回。
        const ed = editor.value;
        if (ed && modelToSelect) {
            insertModelTag(ed, {
                modelId: modelToSelect.model_id,
                modelName: modelToSelect.name,
                providerId: modelToSelect.provider_id,
            });
            selectedModel.value = modelToSelect;
        } else if (shouldClearModel) {
            clearSelectedModel();
        }
    }

    /**
     * 清除模型选择状态。
     *
     * @returns void
     */
    function syncSelectedModelCleared() {
        selectedModel.value = null;
    }

    /**
     * 清除模型选择状态，并同步移除编辑器中的 model tag 标签。
     *
     * @returns void
     */
    function clearSelectedModel() {
        syncSelectedModelCleared();

        // 同时移除编辑器中的模型标签
        const ed = editor.value;
        if (ed) {
            removeModelTag(ed);
        }
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
        syncSelectedModelCleared,
        updateDropdownSearchQuery,
        restoreSearchState,
        resetModelDropdownState,
    };
}
