<!--
  - Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
  -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useAlert } from '@composables/useAlert.ts';
    import { useContextMenu } from '@composables/useContextMenu.ts';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
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
            modelsCache.value.set(providerId, models);
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

            // 重新加载服务商列表
            await loadProviders();

            if (newEnabled === 1) {
                alert.success('服务商已启用');
            } else {
                alert.info('服务商已禁用');
            }
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
                          'Base URL'
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
            await loadProviders();
            alert.success('保存成功');
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
            await createProvider({
                ...data,
                name: requireNonEmptyProviderField(data.name, '服务商名称'),
                api_endpoint: requireNonEmptyProviderField(data.api_endpoint, 'Base URL'),
            });
            await loadProviders();
            showAddDialog.value = false;
            alert.success('创建成功');
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
            await loadProviders();
            showEditDialog.value = false;
            alert.success('保存成功');
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
            await loadProviders();
            if (selectedProviderId.value === providerId) {
                selectedProviderId.value = providers.value[0]?.id || null;
                if (selectedProviderId.value) {
                    await loadModelsForProvider(selectedProviderId.value);
                }
            }
            showEditDialog.value = false;
            alert.success('删除成功');
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '删除失败');
        }
    };

    // 模型操作
    const handleCreateModel = async (data: NewModel) => {
        try {
            await createModel(data);
            if (selectedProviderId.value) {
                await loadModelsForProvider(selectedProviderId.value, true); // 强制刷新
            }
            await broadcastModelsUpdated();
            alert.success('创建成功');
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '创建失败');
        }
    };

    const handleUpdateModel = async (id: number, data: Partial<Model>) => {
        try {
            await updateModel({ id, modelPatch: data });
            if (selectedProviderId.value) {
                await loadModelsForProvider(selectedProviderId.value, true); // 强制刷新
            }
            alert.success('保存成功');
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '保存失败');
        }
    };

    const handleDeleteModel = async (id: number, silent = false) => {
        try {
            await deleteModel({ id });
            if (selectedProviderId.value) {
                await loadModelsForProvider(selectedProviderId.value, true); // 强制刷新
            }
            if (!silent) {
                alert.success('删除成功');
            }
        } catch (err) {
            alert.error(err instanceof Error ? err.message : '删除失败');
        }
    };

    const handleSetDefaultModel = async (id: number) => {
        try {
            await setDefaultModel({ modelId: id });
            await loadProviders();

            // 强制刷新模型列表以确保排序正确
            if (selectedProviderId.value) {
                await loadModelsForProvider(selectedProviderId.value, true);
            }

            alert.success('设置成功');
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
                if (!silent) alert.info('未获取到模型列表');
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

            if (newModels.length > 0) {
                await createModels(newModels);
            }

            // 避免展示错误
            if (refreshingProviderId.value !== currentProviderId) {
                return;
            }

            // 批量同步所有模型的元数据（从 llm_metadata 表匹配写入）
            await syncAllModelsMetadata();

            // 避免展示错误
            if (refreshingProviderId.value !== currentProviderId) {
                return;
            }

            await loadModelsForProvider(currentProviderId, true); // 强制刷新缓存
            if (!silent) {
                alert.success(`刷新成功，新增 ${newModels.length} 个模型`);
            }
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
    <div class="flex h-full">
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

        <div ref="contentScrollRef" class="custom-scrollbar flex-1 overflow-y-auto">
            <div v-if="loading" class="flex h-full items-center justify-center">
                <div
                    class="border-primary-100 border-t-primary-500 h-10 w-10 animate-spin rounded-full border-3"
                ></div>
            </div>

            <div v-else-if="error" class="flex h-full items-center justify-center">
                <div class="rounded-lg border border-gray-200 bg-white p-6 text-gray-600">
                    <p class="font-medium text-gray-900">加载失败</p>
                    <p class="mt-1 text-sm">{{ error }}</p>
                    <button
                        class="bg-primary-500 hover:bg-primary-600 mt-4 rounded-lg px-4 py-2 text-sm text-white transition-colors"
                        @click="() => loadProviders()"
                    >
                        重试
                    </button>
                </div>
            </div>

            <div v-else-if="selectedProvider" class="p-6">
                <div class="mx-auto max-w-4xl space-y-6">
                    <div class="rounded-lg border border-gray-200 bg-white p-6">
                        <div class="flex items-center gap-4">
                            <BadgedLogo
                                :logo="selectedProvider.logo"
                                :name="selectedProvider.name"
                                size="large"
                                :show-badge="selectedProvider.is_builtin === 1"
                            />

                            <div class="flex-1">
                                <div class="flex items-center gap-2">
                                    <h2 class="font-serif text-xl font-semibold text-gray-900">
                                        {{ selectedProvider.name }}
                                    </h2>
                                    <span
                                        class="bg-primary-50 text-primary-600 rounded-full px-2 py-0.5 text-xs font-medium"
                                    >
                                        {{ selectedProviderDriverLabel }}
                                    </span>
                                </div>
                            </div>
                            <button
                                v-if="!selectedProvider.is_builtin"
                                class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                                title="编辑服务商"
                                @click="handleEditProvider"
                            >
                                <AppIcon name="edit" class="h-5 w-5" />
                            </button>
                        </div>
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
