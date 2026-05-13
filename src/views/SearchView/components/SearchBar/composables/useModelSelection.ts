import { findModelsWithProvider } from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import { computed, onMounted, type Ref, ref, watch } from 'vue';

import { aiService } from '@/services/AgentService';
import { parseModelModalities } from '@/utils/modelSchemas';
import type { SearchModelDropdownContext } from '@/views/SearchView/types';

import type { SearchModelOverride } from '../types';

export interface ModelCapabilities {
    supportsImages: boolean;
    supportsFiles: boolean;
}

interface UseModelSelectionOptions {
    searchBarContainerRef: Ref<HTMLElement | null>;
    logoContainerRef: Ref<HTMLElement | null>;
    modelOverride: Ref<SearchModelOverride>;
}

export interface UseModelSelectionDeps {
    findModels: () => Promise<ModelWithProvider[]>;
    getActiveModel: () => Promise<ModelWithProvider | null>;
    findModelByOverride: (override: SearchModelOverride) => Promise<ModelWithProvider | null>;
}

const DEFAULT_DEPS: UseModelSelectionDeps = {
    findModels: () => findModelsWithProvider(),
    getActiveModel: () => aiService.getModel(),
    findModelByOverride: async (override) => {
        if (!override.modelId || override.providerId === null) {
            return null;
        }

        return (
            (
                await findModelsWithProvider({
                    providerId: override.providerId,
                })
            ).find((model) => model.model_id === override.modelId) ?? null
        );
    },
};

/**
 * 模型选择流程。
 * 负责模型覆盖选择、候选模型加载与能力计算。
 *
 * @param options 模型选择依赖项。
 * @param deps 可注入模型服务依赖。
 * @returns 模型展示状态、能力计算结果与下拉控制方法。
 */
export function useModelSelection(
    options: UseModelSelectionOptions,
    deps: UseModelSelectionDeps = DEFAULT_DEPS
) {
    const { searchBarContainerRef, logoContainerRef, modelOverride } = options;

    const activeModel = ref<ModelWithProvider | null>(null);
    const hasResolvedActiveModel = ref(false);
    const resolvedOverrideModel = ref<ModelWithProvider | null>(null);
    const availableModels = ref<ModelWithProvider[]>([]);
    let hasLoadedPopupModels = false;
    let popupModelsLoadPromise: Promise<ModelWithProvider[]> | null = null;
    let resolveOverrideRequestId = 0;

    const selectedModel = computed(() => {
        const { modelId, providerId } = modelOverride.value;
        if (!modelId) {
            return null;
        }

        const matchedAvailableModel =
            availableModels.value.find(
                (model) => model.model_id === modelId && model.provider_id === providerId
            ) ?? null;
        if (matchedAvailableModel) {
            return matchedAvailableModel;
        }

        const matchedActiveModel =
            activeModel.value?.model_id === modelId && activeModel.value?.provider_id === providerId
                ? activeModel.value
                : null;
        if (matchedActiveModel) {
            return matchedActiveModel;
        }

        return resolvedOverrideModel.value?.model_id === modelId &&
            resolvedOverrideModel.value?.provider_id === providerId
            ? resolvedOverrideModel.value
            : null;
    });

    const hasExplicitModelOverride = computed(() => {
        const { modelId, providerId } = modelOverride.value;
        if (!modelId || providerId === null || !hasResolvedActiveModel.value) {
            return false;
        }

        return (
            modelId !== activeModel.value?.model_id || providerId !== activeModel.value?.provider_id
        );
    });

    const selectedModelId = computed(() =>
        hasExplicitModelOverride.value ? modelOverride.value.modelId : null
    );
    const selectedModelName = computed(() => selectedModel.value?.name ?? null);
    const selectedProviderId = computed(() =>
        hasExplicitModelOverride.value ? modelOverride.value.providerId : null
    );

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
        } finally {
            hasResolvedActiveModel.value = true;
        }
    }

    /**
     * 会话切换时页面会直接写入受控 modelOverride，但此时 dropdown 候选模型通常还没加载。
     * 这里按 override 精确解析一次模型，保证历史会话切回来也能立即显示正确模型标签。
     */
    async function resolveControlledOverrideModel() {
        const override = modelOverride.value;
        if (!override.modelId || override.providerId === null) {
            resolvedOverrideModel.value = null;
            return;
        }

        const matchedAvailableModel =
            availableModels.value.find(
                (model) =>
                    model.model_id === override.modelId && model.provider_id === override.providerId
            ) ?? null;
        if (matchedAvailableModel) {
            resolvedOverrideModel.value = matchedAvailableModel;
            return;
        }

        if (
            activeModel.value?.model_id === override.modelId &&
            activeModel.value?.provider_id === override.providerId
        ) {
            resolvedOverrideModel.value = activeModel.value;
            return;
        }

        const requestId = ++resolveOverrideRequestId;
        try {
            const resolvedModel = await deps.findModelByOverride(override);
            if (requestId !== resolveOverrideRequestId) {
                return;
            }

            resolvedOverrideModel.value = resolvedModel;
        } catch (error) {
            if (requestId !== resolveOverrideRequestId) {
                return;
            }

            console.error('[SearchBar] Failed to resolve controlled override model:', error);
            resolvedOverrideModel.value = null;
        }
    }

    /**
     * 确保弹窗候选模型已就绪。
     *
     * hover 预取与点击模型入口都会走这里；一旦已有结果或已有进行中的查询，
     * 就直接复用，避免多条入口各自打一遍数据库。
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

    function invalidatePopupModels() {
        hasLoadedPopupModels = false;
        popupModelsLoadPromise = null;
    }

    /**
     * 打开模型下拉前预取候选模型。
     *
     * @returns Promise<void>
     */
    async function prepareModelDropdownOpen() {
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

        const model = availableModels.value.find((item) => item.id === modelDbId);
        if (model) {
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

        return nextModelOverride;
    }

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
     * 获取模型下拉定位锚点。
     *
     * @returns 模型 logo 容器元素；logo 尚未挂载时返回 SearchBar 容器。
     */
    function getModelDropdownAnchor() {
        return logoContainerRef.value ?? searchBarContainerRef.value;
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
            models: availableModels.value,
        };
    }

    onMounted(async () => {
        await loadActiveModel();
    });

    watch(
        () => [
            modelOverride.value.modelId,
            modelOverride.value.providerId,
            activeModel.value?.model_id ?? null,
            activeModel.value?.provider_id ?? null,
            availableModels.value.length,
        ],
        () => {
            void resolveControlledOverrideModel();
        },
        { immediate: true }
    );

    return {
        selectedModelId,
        selectedModelName,
        selectedProviderId,
        selectedModel,
        activeModel,
        modelCapabilities,
        loadActiveModel,
        loadPopupModels,
        invalidatePopupModels,
        prepareModelDropdownOpen,
        handleModelSelect,
        getModelDropdownAnchor,
        getModelDropdownContext,
    };
}
