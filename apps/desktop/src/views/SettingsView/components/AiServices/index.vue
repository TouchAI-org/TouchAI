<!--
  - Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
  -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import LoadingState from '@components/LoadingState.vue';
    import { useAlert } from '@composables/useAlert.ts';
    import { useContextMenu } from '@composables/useContextMenu.ts';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { db } from '@database';
    import {
        createModel,
        createModels,
        createProvider,
        deleteModel,
        deleteProvider,
        findAllProvidersSorted,
        findDefaultModel,
        findModelsWithProvider,
        findProviderById,
        setDefaultModel,
        syncAllModelsMetadata,
        updateModel,
        updateProvider,
    } from '@database/queries';
    import { isLlmMetadataEmpty } from '@database/queries/llmMetadata.ts';
    import type { ModelWithProvider } from '@database/queries/models.ts';
    import type { Model, NewModel, NewProvider, Provider } from '@database/schema.ts';
    import { AppEvent, eventService } from '@services/EventService';
    import { computed, onMounted, ref } from 'vue';

    import { aiService } from '@/services/AgentService';
    import { updateModelMetadata } from '@/services/AgentService/infrastructure/modelMetadata';
    import { getProviderDriverDefinition } from '@/services/AgentService/infrastructure/providers';

    defineOptions({
        name: 'SettingsAiServicesSection',
    });

    import AddProviderDialog from './components/AddProviderDialog.vue';
    import BadgedLogo from './components/BadgedLogo.vue';
    import EditProviderDialog from './components/EditProviderDialog.vue';
    import ModelList from './components/ModelList.vue';
    import ProviderConfig from './components/ProviderConfig.vue';
    import ProviderList from './components/ProviderList.vue';

    const alert = useAlert();

    const contentScrollRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(contentScrollRef);

    const { open: openProviderMenu } = useContextMenu<number>(
        [
            { key: 'edit', label: '编辑', icon: 'edit' },
            { key: 'delete', label: '删除', icon: 'trash', danger: true },
        ],
        (key, providerId) => {
            if (key === 'edit') {
                selectedProviderId.value = providerId;
                showEditDialog.value = true;
            } else if (key === 'delete') {
                handleDeleteProvider(providerId);
            }
        }
    );

    const providers = ref<Provider[]>([]);
    const modelsCache = ref<Map<number, ModelWithProvider[]>>(new Map()); // 缓存每个服务商的模型
    const selectedProviderId = ref<number | null>(null);
    const defaultModelId = ref<number | null>(null);
    const defaultModelProviderId = ref<number | null>(null);
    const loading = ref(true);
    const loadingModels = ref(false);
    const error = ref<string | null>(null);
    const showAddDialog = ref(false);
    const showEditDialog = ref(false);
    const refreshing = ref(false);
    const refreshingProviderId = ref<number | null>(null);

    async function broadcastModelsUpdated() {
        await eventService.emit(AppEvent.AI_MODELS_UPDATED, {
            updatedAt: Date.now(),
        });
    }

    function setCachedModels(providerId: number, models: ModelWithProvider[]) {
        const nextCache = new Map(modelsCache.value);
        nextCache.set(providerId, models);
        modelsCache.value = nextCache;
    }

    function removeCachedModels(providerId: number) {
        const nextCache = new Map(modelsCache.value);
        nextCache.delete(providerId);
        modelsCache.value = nextCache;
    }

    function patchCachedModel(modelId: number, patch: Partial<Model>) {
        const nextCache = new Map(modelsCache.value);
        for (const [providerId, providerModels] of nextCache.entries()) {
            nextCache.set(
                providerId,
                providerModels.map((model) =>
                    model.id === modelId ? { ...model, ...patch } : model
                )
            );
        }
        modelsCache.value = nextCache;
    }

    function removeCachedModel(modelId: number) {
        const nextCache = new Map(modelsCache.value);
        for (const [providerId, providerModels] of nextCache.entries()) {
            nextCache.set(
                providerId,
                providerModels.filter((model) => model.id !== modelId)
            );
        }
        modelsCache.value = nextCache;
    }

    function findCachedModel(modelId: number): ModelWithProvider | undefined {
        for (const providerModels of modelsCache.value.values()) {
            const model = providerModels.find((item) => item.id === modelId);
            if (model) {
                return model;
            }
        }

        return undefined;
    }

    function patchProvider(providerId: number, patch: Partial<Provider>) {
        providers.value = providers.value.map((provider) =>
            provider.id === providerId ? { ...provider, ...patch } : provider
        );
    }

    function toModelWithProvider(model: Model, provider: Provider): ModelWithProvider {
        return {
            ...model,
            provider_name: provider.name,
            provider_driver: provider.driver,
            api_endpoint: provider.api_endpoint,
            api_key: provider.api_key,
            provider_config_json: provider.config_json,
            provider_enabled: provider.enabled,
            provider_logo: provider.logo,
        };
    }

    // 计算属性
    const selectedProvider = computed(() =>
        providers.value.find((p) => p.id === selectedProviderId.value)
    );

    const selectedProviderDriverLabel = computed(() =>
        selectedProvider.value
            ? getProviderDriverDefinition(selectedProvider.value.driver).label
            : ''
    );

    const selectedProviderModels = computed(() => {
        if (!selectedProviderId.value) return [];
        return modelsCache.value.get(selectedProviderId.value) || [];
    });

    const defaultModelProviderIds = computed(() => {
        const ids = new Set<number>();
        if (defaultModelProviderId.value !== null) {
            ids.add(defaultModelProviderId.value);
            return ids;
        }
        return ids;
    });

    // 加载服务商列表
    const loadProviders = async () => {
        try {
            loading.value = true;
            error.value = null;

            providers.value = await findAllProvidersSorted();

            const defaultModel = await findDefaultModel();
            defaultModelId.value = defaultModel?.id || null;
            defaultModelProviderId.value = defaultModel?.provider_id || null;

            // 自动选择第一个服务商
            if (providers.value.length > 0 && !selectedProviderId.value) {
                selectedProviderId.value = providers.value[0]?.id || null;
                if (selectedProviderId.value) {
                    await loadModelsForProvider(selectedProviderId.value);
                }
            }
        } catch (err) {
            error.value = err instanceof Error ? err.message : '加载失败';
            console.error('Failed to load providers:', err);
        } finally {
            loading.value = false;
        }
    };

    // 加载指定服务商的模型（带缓存）
    const loadModelsForProvider = async (providerId: number, forceReload = false) => {
        // 如果缓存中已有数据且不强制刷新，直接返回
        if (!forceReload && modelsCache.value.has(providerId)) {
            return;
        }

        try {
            loadingModels.value = true;
            const models = await findModelsWithProvider({ providerId });
            setCachedModels(providerId, models);
        } catch (err) {
            console.error('Failed to load models:', err);
            alert.error('加载模型失败');
        } finally {
            loadingModels.value = false;
        }
    };

    // 服务商操作
    const selectProvider = async (providerId: number) => {
        if (refreshing.value) {
            refreshing.value = false;
            refreshingProviderId.value = null;
        }

        selectedProviderId.value = providerId;

        // 加载该服务商的模型（使用缓存）
        await loadModelsForProvider(providerId);
    };

    const toggleProviderEnabled = async (providerId: number) => {
        try {
            const provider = providers.value.find((p) => p.id === providerId);
            if (!provider) return;

            const newEnabled = provider.enabled === 1 ? 0 : 1;
            if (newEnabled === 0) {
                assertProviderCanBeDisabled(provider);
            }

            await updateProvider({
                id: providerId,
                providerPatch: { enabled: newEnabled },
            });

            patchProvider(providerId, { enabled: newEnabled });
            await broadcastModelsUpdated();
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '操作失败');
        }
    };

    const handleValidationError = (message: string) => {
        alert.error(message);
    };

    function requireNonEmptyProviderField(value: string, label: string): string {
        const normalizedValue = value.trim();
        if (!normalizedValue) {
            throw new Error(`${label}不能为空`);
        }
        return normalizedValue;
    }

    function normalizeProviderPatch(providerPatch: Partial<Provider>): Partial<Provider> {
        return {
            ...providerPatch,
            ...(providerPatch.name !== undefined
                ? {
                      name: requireNonEmptyProviderField(providerPatch.name, '服务商名称'),
                  }
                : {}),
            ...(providerPatch.api_endpoint !== undefined
                ? {
                      api_endpoint: requireNonEmptyProviderField(
                          providerPatch.api_endpoint,
                          '请求地址'
                      ),
                  }
                : {}),
        };
    }

    function assertProviderCanBeDisabled(provider: Provider) {
        if (defaultModelProviderId.value === provider.id) {
            throw new Error('无法禁用包含默认模型的服务商，请先设置其他模型为默认');
        }
    }

    function assertProviderCanBeDeleted(provider: Provider) {
        if (provider.is_builtin) {
            throw new Error('无法删除内置服务商');
        }

        if (defaultModelProviderId.value === provider.id) {
            throw new Error('无法删除包含默认模型的服务商，请先设置其他模型为默认');
        }
    }

    const handleProviderContextMenu = (providerId: number, event: MouseEvent) => {
        openProviderMenu(event, providerId);
    };

    const handleUpdateProvider = async (data: Partial<Provider>) => {
        if (!selectedProviderId.value) return;

        try {
            const normalizedProviderPatch = normalizeProviderPatch(data);
            await updateProvider({
                id: selectedProviderId.value,
                providerPatch: normalizedProviderPatch,
            });
            patchProvider(selectedProviderId.value, normalizedProviderPatch);
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '保存失败');
        }
    };

    const handleAddCustomProvider = () => {
        showAddDialog.value = true;
    };

    const handleEditProvider = () => {
        showEditDialog.value = true;
    };

    const handleCreateProvider = async (data: NewProvider) => {
        try {
            const createdProvider = await createProvider({
                ...data,
                name: requireNonEmptyProviderField(data.name, '服务商名称'),
                api_endpoint: requireNonEmptyProviderField(data.api_endpoint, '请求地址'),
            });
            providers.value = [...providers.value, createdProvider];
            if (!selectedProviderId.value) {
                selectedProviderId.value = createdProvider.id;
            }
            showAddDialog.value = false;
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '创建失败');
        }
    };

    const handleUpdateProviderInfo = async (data: Partial<Provider>) => {
        if (!selectedProviderId.value) return;

        try {
            const normalizedProviderPatch = normalizeProviderPatch(data);
            await updateProvider({
                id: selectedProviderId.value,
                providerPatch: normalizedProviderPatch,
            });
            patchProvider(selectedProviderId.value, normalizedProviderPatch);
            showEditDialog.value = false;
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '保存失败');
        }
    };

    const handleDeleteProvider = async (providerId: number) => {
        try {
            const provider = providers.value.find((item) => item.id === providerId);
            if (!provider) {
                throw new Error('服务商不存在');
            }

            assertProviderCanBeDeleted(provider);
            await deleteProvider({ id: providerId });
            providers.value = providers.value.filter((item) => item.id !== providerId);
            removeCachedModels(providerId);
            if (selectedProviderId.value === providerId) {
                selectedProviderId.value = providers.value[0]?.id || null;
                if (selectedProviderId.value) {
                    await loadModelsForProvider(selectedProviderId.value);
                }
            }
            showEditDialog.value = false;
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '删除失败');
        }
    };

    // 模型操作
    const handleCreateModel = async (data: NewModel) => {
        try {
            const createdModel = await createModel(data);
            const provider = providers.value.find((item) => item.id === createdModel.provider_id);
            if (provider) {
                const providerModels = modelsCache.value.get(createdModel.provider_id) || [];
                setCachedModels(createdModel.provider_id, [
                    ...providerModels,
                    toModelWithProvider(createdModel, provider),
                ]);
            } else if (selectedProviderId.value) {
                await loadModelsForProvider(selectedProviderId.value, true);
            }
            await broadcastModelsUpdated();
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '创建失败');
        }
    };

    const handleUpdateModel = async (id: number, data: Partial<Model>) => {
        try {
            await updateModel({ id, modelPatch: data });
            patchCachedModel(id, data);
            await broadcastModelsUpdated();
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '保存失败');
        }
    };

    const handleDeleteModel = async (id: number, silent = false) => {
        try {
            await deleteModel({ id });
            removeCachedModel(id);
            await broadcastModelsUpdated();
            if (!silent && defaultModelId.value === id) {
                defaultModelId.value = null;
                defaultModelProviderId.value = null;
            }
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '删除失败');
        }
    };

    const handleSetDefaultModel = async (id: number) => {
        try {
            const nextDefaultModel = findCachedModel(id);
            await setDefaultModel({ modelId: id });
            defaultModelId.value = id;
            defaultModelProviderId.value =
                nextDefaultModel?.provider_id ?? selectedProviderId.value ?? null;

            const nextCache = new Map(modelsCache.value);
            for (const [providerId, providerModels] of nextCache.entries()) {
                nextCache.set(
                    providerId,
                    providerModels.map((model) => ({
                        ...model,
                        is_default: model.id === id ? 1 : 0,
                    }))
                );
            }
            modelsCache.value = nextCache;

            await broadcastModelsUpdated();
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '设置失败');
        }
    };

    // 刷新模型列表
    const handleRefreshModels = async (silent = false) => {
        if (!selectedProviderId.value) return;

        const currentProviderId = selectedProviderId.value;
        refreshingProviderId.value = currentProviderId;

        try {
            refreshing.value = true;
            const provider = await findProviderById({ id: currentProviderId });
            if (!provider) {
                if (!silent) alert.error('服务商不存在');
                return;
            }

            if (refreshingProviderId.value !== currentProviderId) {
                return;
            }

            // 如果有 API key 就直接用，没有就用占位符（部分厂商支持无key获取模型列表）
            const apiKey = provider.api_key || 'placeholder_for_models';
            const providerInstance = aiService.createProviderInstance(
                provider.driver,
                provider.api_endpoint,
                apiKey,
                provider.config_json
            );

            let fetchedModels;
            try {
                fetchedModels = await providerInstance.listModels();
            } catch (error) {
                if (refreshingProviderId.value !== currentProviderId) {
                    return;
                }

                const errorMessage = error instanceof Error ? error.message : String(error);
                const isAuthError =
                    errorMessage.includes('401') ||
                    errorMessage.includes('403') ||
                    errorMessage.includes('Unauthorized') ||
                    errorMessage.includes('authentication') ||
                    errorMessage.includes('API key');

                // 如果是认证错误且没有配置 key，提示用户
                if (isAuthError && !provider.api_key) {
                    if (!silent) {
                        alert.warning('该服务商需要配置 API Key 才能获取模型列表');
                    }
                    return;
                }

                // 其他错误直接抛出
                throw error;
            }

            // 避免展示错误
            if (refreshingProviderId.value !== currentProviderId) {
                return;
            }

            if (fetchedModels.length === 0) {
                return;
            }

            const existingModels = await findModelsWithProvider({
                providerId: provider.id,
            });
            const existingModelIds = new Set(existingModels.map((m) => m.model_id));

            const newModels = fetchedModels
                .filter((fetchedModel) => !existingModelIds.has(fetchedModel.id))
                .map((fetchedModel) => ({
                    provider_id: provider.id,
                    name: fetchedModel.name,
                    model_id: fetchedModel.id,
                    is_default: 0,
                }));

            // 避免展示错误
            if (refreshingProviderId.value !== currentProviderId) {
                return;
            }

            await db.transaction(async (tx) => {
                if (newModels.length > 0) {
                    await createModels(newModels, tx);
                }

                await syncAllModelsMetadata(tx);
            });

            // 避免展示错误
            if (refreshingProviderId.value !== currentProviderId) {
                return;
            }

            await loadModelsForProvider(currentProviderId, true); // 强制刷新缓存
            await broadcastModelsUpdated();
        } catch (err) {
            if (refreshingProviderId.value !== currentProviderId) {
                return;
            }

            console.error('Failed to refresh models:', err);
            if (!silent) {
                alert.error(`获取模型列表失败:${err}`);
            }
        } finally {
            if (refreshingProviderId.value === currentProviderId) {
                refreshing.value = false;
                refreshingProviderId.value = null;
            }
        }
    };

    onMounted(async () => {
        // 检查 llm-metadata 是否为空，如果为空则自动获取
        try {
            const isEmpty = await isLlmMetadataEmpty();
            if (isEmpty) {
                console.log('[AiServicesView] llm-metadata is empty, fetching...');
                await updateModelMetadata();
                console.log('[AiServicesView] llm-metadata fetched successfully');
            }
        } catch (error) {
            console.error('[AiServicesView] Failed to check or update llm-metadata:', error);
        }

        loadProviders();
    });
</script>

<template>
    <div class="flex h-full bg-white">
        <ProviderList
            :providers="providers"
            :selected-provider-id="selectedProviderId"
            :default-model-provider-ids="defaultModelProviderIds"
            @select="selectProvider"
            @toggle-enabled="toggleProviderEnabled"
            @add-custom="handleAddCustomProvider"
            @validation-error="handleValidationError"
            @context-menu="handleProviderContextMenu"
        />

        <div ref="contentScrollRef" class="settings-scrollbar min-w-0 flex-1 overflow-y-auto">
            <LoadingState v-if="loading" variant="brand" fill="min" />

            <div v-else-if="error" class="flex h-full items-center justify-center">
                <div class="settings-card text-neutral-600">
                    <p class="font-medium text-neutral-950">加载失败</p>
                    <p class="mt-1 text-sm">{{ error }}</p>
                    <button class="settings-button-primary mt-4" @click="() => loadProviders()">
                        重试
                    </button>
                </div>
            </div>

            <div v-else-if="selectedProvider" class="settings-page-wide">
                <div class="space-y-8">
                    <div
                        data-testid="settings-provider-header"
                        class="flex min-h-[64px] items-center justify-between gap-6"
                    >
                        <div
                            data-testid="settings-provider-identity"
                            class="flex min-w-0 items-center gap-4"
                        >
                            <BadgedLogo
                                :logo="selectedProvider.logo"
                                :name="selectedProvider.name"
                                size="large"
                                :show-badge="selectedProvider.is_builtin === 1"
                            />

                            <div data-testid="settings-provider-copy" class="min-w-0 self-center">
                                <div
                                    data-testid="settings-provider-title-row"
                                    class="flex flex-wrap items-center gap-2"
                                >
                                    <h1 class="settings-page-title">
                                        {{ selectedProvider.name }}
                                    </h1>
                                    <span
                                        v-if="selectedProvider.is_builtin !== 1"
                                        data-testid="settings-provider-driver-badge"
                                        class="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600 ring-1 ring-neutral-200"
                                    >
                                        {{ selectedProviderDriverLabel }}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <button
                            v-if="!selectedProvider.is_builtin"
                            data-testid="settings-provider-edit-button"
                            class="settings-icon-button"
                            title="编辑服务商"
                            @click="handleEditProvider"
                        >
                            <AppIcon name="edit" class="h-5 w-5" />
                        </button>
                    </div>

                    <ProviderConfig :provider="selectedProvider" @update="handleUpdateProvider" />

                    <ModelList
                        :provider-id="selectedProvider.id"
                        :models="selectedProviderModels"
                        :default-model-id="defaultModelId"
                        :provider="selectedProvider"
                        :provider-enabled="selectedProvider.enabled === 1"
                        :refreshing="refreshing"
                        @create="handleCreateModel"
                        @update="handleUpdateModel"
                        @delete="handleDeleteModel"
                        @set-default="handleSetDefaultModel"
                        @refresh="handleRefreshModels"
                    />
                </div>
            </div>
        </div>

        <AddProviderDialog
            v-if="showAddDialog"
            @create="handleCreateProvider"
            @cancel="showAddDialog = false"
        />

        <EditProviderDialog
            v-if="showEditDialog && selectedProvider"
            :provider="selectedProvider"
            @update="handleUpdateProviderInfo"
            @cancel="showEditDialog = false"
        />
    </div>
</template>
