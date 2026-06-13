<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import type { Model, NewModel, Provider } from '@database/schema';
    import { computed, ref, watch } from 'vue';

    import { t, tp } from '@/i18n';

    import AddModelDialog from './AddModelDialog.vue';
    import EditModelDialog from './EditModelDialog.vue';
    import ModelGroup from './ModelGroup.vue';
    interface Props {
        providerId: number;
        models: Model[];
        defaultModelId: number | null;
        provider: Provider | undefined;
        providerEnabled: boolean;
        refreshing?: boolean;
    }

    interface Emits {
        (e: 'create', data: NewModel): void;
        (e: 'update', id: number, data: Partial<Model>): void;
        (e: 'delete', id: number, silent?: boolean): void;
        (e: 'batch-delete', ids: number[]): void;
        (e: 'set-default', id: number): void;
        (e: 'refresh'): void;
        (e: 'refreshing', value: boolean): void;
        (e: 'add-to-selection', id: number): void;
        (e: 'remove-from-selection', id: number): void;
    }

    interface ModelGroupData {
        groupKey: string;
        groupName: string;
        models: Model[];
    }

    function extractGroupKey(modelId: string): string {
        const beforeSlash = modelId.split('/')[0] || modelId;
        const withoutVersion = beforeSlash.replace(
            /[-\s]+(v?\d+[\d.]*|latest|preview|beta|alpha).*$/i,
            ''
        );

        if (!withoutVersion) {
            return beforeSlash;
        }

        return withoutVersion;
    }

    function extractBaseGroupKey(groupKey: string): string {
        const parts = groupKey.split('-');
        if (parts.length > 1) {
            return parts[0] || '';
        }
        return groupKey;
    }

    function groupModels(models: Model[], defaultModelId?: number | null): ModelGroupData[] {
        const groupMap = new Map<string, Model[]>();
        let defaultModelGroupKey: string | null = null;

        for (const model of models) {
            const groupKey = extractGroupKey(model.model_id);

            if (!groupMap.has(groupKey)) {
                groupMap.set(groupKey, []);
            }

            groupMap.get(groupKey)!.push(model);

            if (defaultModelId && model.id === defaultModelId) {
                defaultModelGroupKey = groupKey;
            }
        }

        const groups: ModelGroupData[] = [];

        for (const [groupKey, groupModels] of groupMap.entries()) {
            const sortedModels = [...groupModels].sort((a, b) => {
                if (defaultModelId && a.id === defaultModelId) return -1;
                if (defaultModelId && b.id === defaultModelId) return 1;
                return a.model_id.localeCompare(b.model_id);
            });

            groups.push({
                groupKey,
                groupName: groupKey,
                models: sortedModels,
            });
        }

        const mergedGroups: ModelGroupData[] = [];
        const singleModelGroups = groups.filter((g) => g.models.length === 1);
        const multiModelGroups = groups.filter((g) => g.models.length > 1);

        const baseGroupMap = new Map<string, ModelGroupData[]>();
        for (const group of singleModelGroups) {
            const baseKey = extractBaseGroupKey(group.groupKey);
            if (!baseGroupMap.has(baseKey)) {
                baseGroupMap.set(baseKey, []);
            }
            baseGroupMap.get(baseKey)!.push(group);
        }

        for (const [baseKey, groupsWithSameBase] of baseGroupMap.entries()) {
            if (groupsWithSameBase.length > 1) {
                const allModels = groupsWithSameBase.flatMap((g) => g.models);

                const sortedModels = allModels.sort((a, b) => {
                    if (defaultModelId && a.id === defaultModelId) return -1;
                    if (defaultModelId && b.id === defaultModelId) return 1;
                    return a.model_id.localeCompare(b.model_id);
                });

                mergedGroups.push({
                    groupKey: baseKey,
                    groupName: baseKey,
                    models: sortedModels,
                });

                if (allModels.some((m) => m.id === defaultModelId)) {
                    defaultModelGroupKey = baseKey;
                }
            } else {
                const singleGroup = groupsWithSameBase[0];
                if (singleGroup) {
                    mergedGroups.push(singleGroup);
                }
            }
        }

        const finalGroups = [...multiModelGroups, ...mergedGroups];

        finalGroups.sort((a, b) => {
            if (a.groupKey === defaultModelGroupKey) return -1;
            if (b.groupKey === defaultModelGroupKey) return 1;
            return a.groupName.localeCompare(b.groupName);
        });

        return finalGroups;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const alert = useAlert();
    const { confirm } = useConfirm();

    const showAddDialog = ref(false);
    const showEditDialog = ref(false);
    const editingModel = ref<Model | null>(null);
    const searchQuery = ref('');
    const regexMode = ref(false);
    const regexError = ref<string | null>(null);
    const multiSelectMode = ref(false);
    const selectedModelIds = ref<Set<number>>(new Set());

    watch(
        () => props.providerId,
        () => {
            multiSelectMode.value = false;
            selectedModelIds.value = new Set();
        }
    );

    const searchPlaceholder = computed(() => {
        if (props.models.length > 0) {
            return tp('settings.ai.modelSearchPlaceholder', props.models.length);
        }
        return t('settings.ai.modelSearchGenericPlaceholder');
    });

    const selectionModels = computed(() => props.models.filter((m) => m.is_selected === 1));
    const supportModels = computed(() => props.models.filter((m) => m.is_selected === 0));

    function applySearch(models: Model[]): Model[] {
        if (!searchQuery.value.trim()) return models;

        if (regexMode.value) {
            try {
                const regex = new RegExp(searchQuery.value, 'i');
                regexError.value = null;
                return models.filter(
                    (model) => regex.test(model.name) || regex.test(model.model_id)
                );
            } catch (err) {
                regexError.value = err instanceof Error ? err.message : String(err);
                return models;
            }
        }

        const query = searchQuery.value.toLowerCase();
        return models.filter(
            (model) =>
                model.name.toLowerCase().includes(query) ||
                model.model_id.toLowerCase().includes(query)
        );
    }

    const filteredSelectionModels = computed(() => applySearch(selectionModels.value));
    const filteredSupportModels = computed(() => applySearch(supportModels.value));

    const selectionModelGroups = computed(() =>
        groupModels(filteredSelectionModels.value, props.defaultModelId)
    );
    const supportModelGroups = computed(() => groupModels(filteredSupportModels.value));

    const allFilteredModelIds = computed(() => {
        const selectionIds = filteredSelectionModels.value.map((m) => m.id);
        const supportIds = filteredSupportModels.value.map((m) => m.id);
        return [...selectionIds, ...supportIds];
    });

    const isAllSelected = computed(() => {
        if (allFilteredModelIds.value.length === 0) return false;
        return allFilteredModelIds.value.every((id) => selectedModelIds.value.has(id));
    });

    const startCreate = () => {
        showAddDialog.value = true;
    };

    const handleCreate = (data: NewModel) => {
        emit('create', data);
        showAddDialog.value = false;
    };

    const handleEdit = (model: Model) => {
        editingModel.value = model;
        showEditDialog.value = true;
    };

    const handleUpdate = (data: Partial<Model>) => {
        if (editingModel.value) {
            emit('update', editingModel.value.id, data);
            showEditDialog.value = false;
            editingModel.value = null;
        }
    };

    const handleCancelEdit = () => {
        showEditDialog.value = false;
        editingModel.value = null;
    };

    const handleRefresh = () => {
        if (!props.provider) {
            alert.error(t('settings.ai.providerInfoMissing'));
            return;
        }

        if (!props.provider.api_endpoint) {
            alert.warning(t('settings.ai.configureApiUrlFirst'));
            return;
        }

        emit('refresh');
    };

    const handleDeleteGroup = async (groupKey: string) => {
        const group = selectionModelGroups.value.find((g) => g.groupKey === groupKey);
        if (!group) return;

        for (let i = 0; i < group.models.length; i++) {
            const model = group.models[i];
            if (!model) continue;
            const isLast = i === group.models.length - 1;
            emit('delete', model.id, !isLast);
        }
    };

    const handleDeleteSupportGroup = async (groupKey: string) => {
        const group = supportModelGroups.value.find((g) => g.groupKey === groupKey);
        if (!group) return;

        for (let i = 0; i < group.models.length; i++) {
            const model = group.models[i];
            if (!model) continue;
            emit('delete', model.id, i < group.models.length - 1);
        }
    };

    const toggleMultiSelect = () => {
        multiSelectMode.value = !multiSelectMode.value;
        if (!multiSelectMode.value) {
            selectedModelIds.value = new Set();
        }
    };

    const exitMultiSelect = () => {
        multiSelectMode.value = false;
        selectedModelIds.value = new Set();
    };

    const toggleModelSelect = (id: number) => {
        const next = new Set(selectedModelIds.value);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        selectedModelIds.value = next;
    };

    const toggleSelectAll = () => {
        if (isAllSelected.value) {
            selectedModelIds.value = new Set();
        } else {
            selectedModelIds.value = new Set(allFilteredModelIds.value);
        }
    };

    const handleBatchDelete = async () => {
        const ids = [...selectedModelIds.value];
        if (ids.length === 0) return;

        const hasDefaultModel = ids.includes(props.defaultModelId ?? -1);
        if (hasDefaultModel) {
            alert.error(t('settings.ai.batchDeleteContainsDefault'));
            return;
        }

        const confirmed = await confirm({
            title: t('settings.ai.confirmDeleteTitle'),
            message: tp('settings.ai.confirmBatchDelete', ids.length),
            type: 'danger',
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
        });

        if (confirmed) {
            emit('batch-delete', ids);
            exitMultiSelect();
        }
    };

    const toggleRegexMode = () => {
        regexMode.value = !regexMode.value;
        regexError.value = null;
    };

    const handleAddToSelection = (model: Model) => {
        emit('add-to-selection', model.id);
    };

    const handleRemoveFromSelection = (model: Model) => {
        emit('remove-from-selection', model.id);
    };
</script>

<template>
    <div class="space-y-6">
        <!-- Toolbar -->
        <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-5">
                <h2 class="flex-shrink-0 text-[15px] font-medium text-neutral-950">
                    {{ t('settings.ai.modelListTitle') }}
                </h2>

                <div class="relative flex-1">
                    <AppIcon
                        name="search"
                        class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400"
                    />
                    <input
                        v-model="searchQuery"
                        type="text"
                        :placeholder="searchPlaceholder"
                        class="settings-input w-full py-1.5 pr-3 pl-9"
                    />
                    <button
                        class="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs font-medium transition-colors"
                        :class="[
                            regexMode
                                ? 'bg-primary-100 text-primary-700 hover:bg-primary-200'
                                : 'bg-neutral-100 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600',
                        ]"
                        :title="
                            regexMode
                                ? t('settings.ai.regexSearchExit')
                                : t('settings.ai.regexSearch')
                        "
                        @click="toggleRegexMode"
                    >
                        .*
                    </button>
                </div>
            </div>

            <div class="flex flex-shrink-0 gap-2">
                <!-- Regex error indicator -->
                <span
                    v-if="regexMode && regexError"
                    class="flex items-center rounded bg-red-50 px-2 py-1 text-xs text-red-600"
                >
                    {{ t('settings.ai.invalidRegex', { error: regexError }) }}
                </span>

                <!-- Multi-select toggle -->
                <button
                    class="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors"
                    :class="[
                        multiSelectMode
                            ? 'border-primary-300 bg-primary-50 text-primary-700 hover:bg-primary-100'
                            : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-900',
                    ]"
                    @click="toggleMultiSelect"
                >
                    {{
                        multiSelectMode
                            ? t('settings.ai.multiSelectExit')
                            : t('settings.ai.multiSelect')
                    }}
                </button>

                <!-- Batch delete button (only in multi-select mode with selections) -->
                <button
                    v-if="multiSelectMode && selectedModelIds.size > 0"
                    class="flex-shrink-0 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-100"
                    @click="handleBatchDelete"
                >
                    {{ t('settings.ai.batchDelete') }}
                    <span class="ml-1 rounded-full bg-red-200 px-1.5 py-0.5 text-xs">
                        {{ selectedModelIds.size }}
                    </span>
                </button>

                <!-- Select all / deselect (only in multi-select mode) -->
                <button
                    v-if="multiSelectMode"
                    class="flex-shrink-0 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:border-neutral-300"
                    @click="toggleSelectAll"
                >
                    {{ isAllSelected ? t('settings.ai.selectNone') : t('settings.ai.selectAll') }}
                </button>

                <button
                    v-if="!multiSelectMode"
                    class="flex-shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors"
                    :class="{
                        'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-900':
                            !refreshing,
                        'cursor-not-allowed border-neutral-200 bg-neutral-50 text-neutral-400':
                            refreshing,
                    }"
                    :disabled="refreshing"
                    :title="t('settings.ai.refreshModelsTitle')"
                    @click="handleRefresh"
                >
                    <span v-if="refreshing" class="inline-flex items-center gap-1.5">
                        <AppIcon name="refresh" class="h-4 w-4 animate-spin" />
                        {{ t('settings.ai.refreshing') }}
                    </span>
                    <span v-else>{{ t('settings.ai.refresh') }}</span>
                </button>
                <button
                    v-if="!multiSelectMode"
                    class="settings-button-primary flex-shrink-0 px-3 py-1.5"
                    @click="startCreate"
                >
                    {{ t('settings.ai.addModelTitle') }}
                </button>
            </div>
        </div>

        <!-- Multi-select count bar -->
        <div
            v-if="multiSelectMode && selectedModelIds.size > 0"
            class="bg-primary-50 flex items-center gap-3 rounded-lg px-4 py-2"
        >
            <span class="text-primary-700 text-sm font-medium">
                {{ t('settings.ai.selectedCount', { count: selectedModelIds.size }) }}
            </span>
        </div>

        <!-- No models at all -->
        <div
            v-if="models.length === 0"
            class="settings-card p-8 text-center"
            data-testid="settings-model-empty-state"
        >
            <div class="mx-auto max-w-sm">
                <AppIcon name="llm" class="mx-auto h-10 w-10 text-neutral-300" />
                <h3 class="mt-3 text-[15px] font-normal text-neutral-950">
                    {{ t('settings.ai.noModels') }}
                </h3>
            </div>
        </div>

        <!-- Search with no results -->
        <div
            v-if="
                models.length > 0 &&
                filteredSelectionModels.length === 0 &&
                filteredSupportModels.length === 0
            "
            class="settings-card p-8 text-center"
        >
            <div class="mx-auto max-w-sm">
                <AppIcon name="search" class="mx-auto h-10 w-10 text-neutral-300" />
                <h3 class="mt-3 text-[15px] font-normal text-neutral-950">
                    {{ t('settings.ai.noMatchingModels') }}
                </h3>
                <p class="mt-1 text-xs text-neutral-500">
                    {{ t('settings.ai.noMatchingModelsDescription', { query: searchQuery }) }}
                </p>
            </div>
        </div>

        <!-- Model Selection Area (用户已选择的模型) -->
        <div v-if="filteredSelectionModels.length > 0" class="space-y-3">
            <div class="flex items-center gap-2">
                <h3 class="text-sm font-semibold text-neutral-800">
                    {{ t('settings.ai.modelSelectionArea') }}
                </h3>
                <span class="text-xs text-neutral-400">({{ selectionModels.length }})</span>
            </div>
            <p class="text-xs text-neutral-400">
                {{ t('settings.ai.modelSelectionAreaDescription') }}
            </p>
            <ModelGroup
                v-for="(group, index) in selectionModelGroups"
                :key="provider?.id + group.groupKey + index"
                :group="group"
                :default-model-id="defaultModelId"
                :provider-enabled="providerEnabled"
                :multi-select-mode="multiSelectMode"
                :selected-model-ids="selectedModelIds"
                area="selection"
                @update="(id, data) => emit('update', id, data)"
                @delete="(id) => emit('delete', id)"
                @delete-group="handleDeleteGroup"
                @set-default="(id: number) => emit('set-default', id)"
                @edit="handleEdit"
                @toggle-select="toggleModelSelect"
                @add-to-selection="handleAddToSelection"
                @remove-from-selection="handleRemoveFromSelection"
            />
        </div>

        <!-- Model Support Area (服务商支持的所有模型) -->
        <div v-if="filteredSupportModels.length > 0" class="space-y-3">
            <div class="flex items-center gap-2">
                <h3 class="text-sm font-semibold text-neutral-500">
                    {{ t('settings.ai.modelSupportArea') }}
                </h3>
                <span class="text-xs text-neutral-400">({{ supportModels.length }})</span>
            </div>
            <p class="text-xs text-neutral-400">
                {{ t('settings.ai.modelSupportAreaDescription') }}
            </p>
            <ModelGroup
                v-for="(group, index) in supportModelGroups"
                :key="'support-' + provider?.id + group.groupKey + index"
                :group="group"
                :default-model-id="defaultModelId"
                :provider-enabled="providerEnabled"
                :multi-select-mode="multiSelectMode"
                :selected-model-ids="selectedModelIds"
                area="support"
                @update="(id, data) => emit('update', id, data)"
                @delete="(id) => emit('delete', id)"
                @delete-group="handleDeleteSupportGroup"
                @set-default="(id: number) => emit('set-default', id)"
                @edit="handleEdit"
                @toggle-select="toggleModelSelect"
                @add-to-selection="handleAddToSelection"
                @remove-from-selection="handleRemoveFromSelection"
            />
        </div>

        <AddModelDialog
            v-if="showAddDialog"
            :provider-id="providerId"
            @create="handleCreate"
            @cancel="showAddDialog = false"
        />

        <EditModelDialog
            v-if="showEditDialog && editingModel"
            :model="editingModel"
            @update="handleUpdate"
            @cancel="handleCancelEdit"
        />
    </div>
</template>
