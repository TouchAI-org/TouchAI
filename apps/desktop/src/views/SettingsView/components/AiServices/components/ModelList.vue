<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useAlert } from '@composables/useAlert';
    import type { Model, NewModel, Provider } from '@database/schema';
    import { computed, ref } from 'vue';

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
        (e: 'set-default', id: number): void;
        (e: 'refresh'): void;
        (e: 'refreshing', value: boolean): void;
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

    const showAddDialog = ref(false);
    const showEditDialog = ref(false);
    const editingModel = ref<Model | null>(null);
    const searchQuery = ref('');

    // 计算 placeholder 文本
    const searchPlaceholder = computed(() => {
        if (props.models.length > 0) {
            return tp('settings.ai.modelSearchPlaceholder', props.models.length);
        }
        return t('settings.ai.modelSearchGenericPlaceholder');
    });

    // 计算分组后的模型
    const modelGroups = computed(() => {
        let filteredModels = props.models;

        // 如果有搜索关键词，过滤模型
        if (searchQuery.value.trim()) {
            const query = searchQuery.value.toLowerCase();
            filteredModels = props.models.filter(
                (model) =>
                    model.name.toLowerCase().includes(query) ||
                    model.model_id.toLowerCase().includes(query)
            );
        }

        return groupModels(filteredModels, props.defaultModelId);
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
        // 检查是否已配置地址
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
        // 找到该分组下的所有模型
        const group = modelGroups.value.find((g) => g.groupKey === groupKey);
        if (!group) return;

        // 删除该分组下的所有模型，使用 silent 模式避免每次都提示
        for (let i = 0; i < group.models.length; i++) {
            const model = group.models[i];
            if (!model) continue;
            const isLast = i === group.models.length - 1;
            emit('delete', model.id, !isLast); // 只有最后一个不是 silent
        }
    };
</script>

<template>
    <div class="space-y-4">
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
                </div>
            </div>

            <div class="flex flex-shrink-0 gap-2">
                <button
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
                    class="settings-button-primary flex-shrink-0 px-3 py-1.5"
                    @click="startCreate"
                >
                    {{ t('settings.ai.addModelTitle') }}
                </button>
            </div>
        </div>

        <div
            v-if="models.length > 0 && modelGroups.length === 0"
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

        <div v-else class="space-y-3">
            <ModelGroup
                v-for="(group, index) in modelGroups"
                :key="provider?.id + group.groupKey + index"
                :group="group"
                :default-model-id="defaultModelId"
                :provider-enabled="providerEnabled"
                @update="(id, data) => emit('update', id, data)"
                @delete="(id) => emit('delete', id)"
                @delete-group="handleDeleteGroup"
                @set-default="(id: number) => emit('set-default', id)"
                @edit="handleEdit"
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
