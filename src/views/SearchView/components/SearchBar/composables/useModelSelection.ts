import { findModelsWithProvider } from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import { aiService } from '@services/AiService';
import type { Editor } from '@tiptap/core';
import { computed, onMounted, type Ref, ref, type ShallowRef } from 'vue';

import { parseModelModalities } from '@/utils/modelSchemas';
import type { SearchModelDropdownContext } from '@/views/SearchView/types';

import type { SearchModelOverride } from '../types';
import { useModelSearchSession } from './useModelSearchSession';

export interface ModelCapabilities {
    supportsImages: boolean;
    supportsFiles: boolean;
}

interface UseModelSelectionOptions {
    searchQuery: Ref<string>;
    editor: ShallowRef<Editor | null>;
    logoContainerRef: Ref<HTMLElement | null>;
    modelOverride: Ref<SearchModelOverride>;
}

export interface UseModelSelectionDeps {
    findModels: () => Promise<ModelWithProvider[]>;
    getActiveModel: () => Promise<ModelWithProvider | null>;
    createSearchSession: typeof useModelSearchSession;
}

const DEFAULT_DEPS: UseModelSelectionDeps = {
    findModels: () => findModelsWithProvider(),
    getActiveModel: () => aiService.getModel(),
    createSearchSession: useModelSearchSession,
};

/**
 * 模型选择流程。
 * 负责模型覆盖选择、模型搜索会话、输入状态恢复与能力计算。
 *
 * @param options 模型选择依赖项。
 * @param deps 可注入模型服务与会话依赖。
 * @returns 模型展示状态、能力计算结果与下拉控制方法。
 */
export function useModelSelection(
    options: UseModelSelectionOptions,
    deps: UseModelSelectionDeps = DEFAULT_DEPS
) {
    const { searchQuery, editor, logoContainerRef, modelOverride } = options;
    const searchSession = deps.createSearchSession({
        searchQuery,
        editor,
    });

    const activeModel = ref<ModelWithProvider | null>(null);
    // 缓存原始模型列表，供 handleModelSelect 使用，避免重复查询数据库。
    const availableModels = ref<ModelWithProvider[]>([]);
    let hasLoadedPopupModels = false;
    let popupModelsLoadPromise: Promise<ModelWithProvider[]> | null = null;
    const selectedModel = computed(() => {
        const { modelId, providerId } = modelOverride.value;
        if (!modelId) {
            return null;
        }

        return (
            availableModels.value.find(
                (model) => model.model_id === modelId && model.provider_id === providerId
            ) ??
            (activeModel.value?.model_id === modelId &&
            activeModel.value?.provider_id === providerId
                ? activeModel.value
                : null)
        );
    });
    const selectedModelId = computed(() => modelOverride.value.modelId);
    const selectedModelName = computed(() => selectedModel.value?.name ?? null);
    const selectedProviderId = computed(() => modelOverride.value.providerId);

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

    /**
     * 确保弹窗候选模型已就绪。
     *
     * hover 预取与 `@` 直接打开都会走这里；一旦已有结果或已有进行中的查询，
     * 就直接复用，避免两条入口各自打一遍数据库。
     *
     * @returns 当前可用的模型列表。
     */
    async function loadPopupModels(): Promise<ModelWithProvider[]> {
        if (hasLoadedPopupModels) {
            return availableModels.value;
        }

        if (popupModelsLoadPromise) {
            return popupModelsLoadPromise;
        }

        popupModelsLoadPromise = (async () => {
            try {
                const models = await deps.findModels();
                availableModels.value = models;
                hasLoadedPopupModels = true;
                return models;
            } catch (error) {
                console.error('[SearchBar] Failed to load popup models:', error);
                availableModels.value = [];
                return [];
            } finally {
                popupModelsLoadPromise = null;
            }
        })();

        return popupModelsLoadPromise;
    }

    /**
     * 进入模型搜索状态，并确保弹窗候选模型可用。
     *
     * @returns Promise<void>
     */
    async function prepareModelDropdownOpen() {
        if (!logoContainerRef.value || searchSession.isModelDropdownOpen.value) return;

        // 领域层只负责进入模型搜索会话与准备数据；何时真正打开 popup
        // 由页面协调层统一决定。
        searchSession.enterModelSearchMode();
        await loadPopupModels();
    }

    /**
     * 处理模型选择。
     *
     * @param modelDbId 模型数据库主键 ID。
     * @returns 页面层应写回的受控模型覆盖值。
     */
    async function handleModelSelect(modelDbId: number): Promise<SearchModelOverride> {
        let nextModelOverride = modelOverride.value;

        const model = availableModels.value.find((m) => m.id === modelDbId);
        if (model) {
            // 再次选择当前默认模型视为"取消覆盖"，恢复跟随全局模型。
            const isDefaultModel =
                model.model_id === activeModel.value?.model_id &&
                model.provider_id === activeModel.value?.provider_id;
            if (isDefaultModel) {
                nextModelOverride = {
                    modelId: null,
                    providerId: null,
                };
            } else {
                nextModelOverride = {
                    modelId: model.model_id,
                    providerId: model.provider_id,
                };
            }
        }

        // 先关闭模型搜索会话，再恢复编辑器内容。
        // 顺序至关重要：setEditorJSON 会同步触发 onUpdate → onInput()，
        // 若 isModelDropdownOpen 仍为 true，onInput 会继续把文本变化当作
        // 模型查询并向页面层同步 dropdown 数据，导致已关闭/待关闭的 dropdown
        // 继续收到更新。
        const restoreSnapshot = searchSession.captureSelectionRestoreSnapshot();

        // 恢复编辑器内容（此时 isModelDropdownOpen=false，onInput 不会继续向页面层
        // 请求同步 dropdown 数据）。
        searchSession.restoreEditorFromSnapshot(restoreSnapshot);

        return nextModelOverride;
    }

    // 6. 模型能力计算
    /**
     * 解析模型模态配置，异常时使用纯文本输入输出。
     *
     * @param modalities 模型模态配置 JSON 字符串。
     * @returns 解析后的输入/输出模态集合。
     */
    function parseModalities(modalities?: string | null) {
        return parseModelModalities(modalities);
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
     * 同步模型下拉搜索词，供页面层 popup driver 刷新弹窗内容。
     *
     * @param query 下拉过滤查询。
     * @returns void
     */
    function updateDropdownSearchQuery(query: string) {
        searchSession.updateDropdownSearchQuery(query);
    }

    /**
     * 获取模型下拉定位锚点。
     *
     * @returns 模型 logo 容器元素。
     */
    function getModelDropdownAnchor() {
        return logoContainerRef.value;
    }

    /**
     * 构造模型下拉领域上下文快照。
     *
     * @returns 页面层映射 popup DTO 所需的数据。
     */
    function getModelDropdownContext(): SearchModelDropdownContext {
        return {
            activeModelId: activeModel.value?.model_id ?? null,
            activeProviderId: activeModel.value?.provider_id ?? null,
            selectedModelId: selectedModelId.value,
            selectedProviderId: selectedProviderId.value,
            searchQuery: searchSession.dropdownSearchQuery.value,
            models: availableModels.value,
        };
    }

    // 页面初始化只加载当前活动模型；弹窗候选列表在需要打开时再查询。
    onMounted(async () => {
        await loadActiveModel();
    });

    return {
        currentPlaceholder: searchSession.currentPlaceholder,
        selectedModelId,
        selectedModelName,
        selectedProviderId,
        selectedModel,
        activeModel,
        isModelDropdownOpen: searchSession.isModelDropdownOpen,
        isSearchingModel: searchSession.isSearchingModel,
        modelCapabilities,
        dropdownSearchQuery: searchSession.dropdownSearchQuery,
        loadActiveModel,
        loadPopupModels,
        prepareModelDropdownOpen,
        updateDropdownSearchQuery,
        resetModelDropdownState: searchSession.resetModelDropdownState,
        handleModelSelect,
        getModelDropdownAnchor,
        getModelDropdownContext,
    };
}
