<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import { useAlert } from '@composables/useAlert';
    import {
        createModelPreference,
        deleteModelPreference,
        findModelRoleWithProvider,
        findModelsWithProvider,
        listModelPreferences,
        setModelRole,
        updateModelPreference,
    } from '@database/queries';
    import type { ModelRole, ModelWithProvider } from '@database/queries/models';
    import type { ModelPreferenceWithModel } from '@database/types';
    import { computed, onMounted, ref } from 'vue';

    import { t } from '@/i18n';

    import ModelPreferenceDialog from './ModelPreferenceDialog.vue';

    defineOptions({
        name: 'ModelPreferences',
    });

    interface PreferenceForm {
        id: number | null;
        name: string;
        description: string;
        modelId: string;
    }

    interface ModelSelectOption {
        label: string;
        value: string;
        description?: string;
    }

    const alert = useAlert();
    const loading = ref(true);
    const saving = ref(false);
    const preferences = ref<ModelPreferenceWithModel[]>([]);
    const models = ref<ModelWithProvider[]>([]);
    const roleModelIds = ref<Record<ModelRole, string>>({
        entry: '',
        fast: '',
        general: '',
    });
    const form = ref<PreferenceForm | null>(null);
    const UNSET_MODEL_VALUE = '__touchai_unset_model__';

    const modelRoles: Array<{
        role: ModelRole;
        required: boolean;
        titleKey: Parameters<typeof t>[0];
        descriptionKey: Parameters<typeof t>[0];
        placeholderKey: Parameters<typeof t>[0];
    }> = [
        {
            role: 'entry',
            required: true,
            titleKey: 'settings.general.modelPreferences.entryModel',
            descriptionKey: 'settings.general.modelPreferences.entryModelDescription',
            placeholderKey: 'settings.general.modelPreferences.selectEntryModel',
        },
        {
            role: 'fast',
            required: false,
            titleKey: 'settings.general.modelPreferences.fastModel',
            descriptionKey: 'settings.general.modelPreferences.fastModelDescription',
            placeholderKey: 'settings.general.modelPreferences.useEntryModel',
        },
        {
            role: 'general',
            required: false,
            titleKey: 'settings.general.modelPreferences.generalModel',
            descriptionKey: 'settings.general.modelPreferences.generalModelDescription',
            placeholderKey: 'settings.general.modelPreferences.useEntryModel',
        },
    ];

    const sortedModels = computed(() =>
        [...models.value].sort(
            (left, right) =>
                left.provider_name.localeCompare(right.provider_name) ||
                left.name.localeCompare(right.name) ||
                left.model_id.localeCompare(right.model_id)
        )
    );

    const modelSelectOptions = computed<ModelSelectOption[]>(() =>
        sortedModels.value
            .filter((model) => model.provider_enabled === 1)
            .map((model) => ({
                label: formatModelOption(model),
                value: String(model.id),
                description: model.model_id,
            }))
    );

    function formatPreferenceModel(preference: ModelPreferenceWithModel): string {
        return [preference.provider_name, preference.model_name].filter(Boolean).join(' / ');
    }

    function formatModelOption(model: ModelWithProvider): string {
        return `${model.provider_name} / ${model.name}`;
    }

    function getRoleModelOptions(modelRole: (typeof modelRoles)[number]): ModelSelectOption[] {
        if (modelRole.required) {
            return modelSelectOptions.value;
        }

        return [
            {
                label: t(modelRole.placeholderKey),
                value: UNSET_MODEL_VALUE,
            },
            ...modelSelectOptions.value,
        ];
    }

    function getRoleModelValue(modelRole: (typeof modelRoles)[number]): string {
        const value = roleModelIds.value[modelRole.role];
        return modelRole.required || value ? value : UNSET_MODEL_VALUE;
    }

    function updateRoleModel(role: ModelRole, value: string) {
        roleModelIds.value[role] = value === UNSET_MODEL_VALUE ? '' : value;
        void saveModelRole(role);
    }

    function createEmptyForm(): PreferenceForm {
        return {
            id: null,
            name: '',
            description: '',
            modelId: '',
        };
    }

    async function loadData() {
        loading.value = true;
        try {
            const [nextPreferences, nextModels, entryModel, fastModel, generalModel] =
                await Promise.all([
                    listModelPreferences(),
                    findModelsWithProvider(),
                    findModelRoleWithProvider('entry'),
                    findModelRoleWithProvider('fast'),
                    findModelRoleWithProvider('general'),
                ]);
            preferences.value = nextPreferences;
            models.value = nextModels;
            roleModelIds.value = {
                entry: entryModel ? String(entryModel.id) : '',
                fast: fastModel ? String(fastModel.id) : '',
                general: generalModel ? String(generalModel.id) : '',
            };
        } catch (error) {
            console.error('[ModelPreferences] Failed to load data:', error);
            alert.error(t('settings.general.modelPreferences.loadFailed'));
        } finally {
            loading.value = false;
        }
    }

    function startCreate() {
        form.value = createEmptyForm();
    }

    function startEdit(preference: ModelPreferenceWithModel) {
        form.value = {
            id: preference.id,
            name: preference.name,
            description: preference.description,
            modelId: preference.model_id === null ? '' : String(preference.model_id),
        };
    }

    function cancelEdit() {
        form.value = null;
    }

    async function saveModelRole(role: ModelRole) {
        const rawModelId = roleModelIds.value[role];
        const modelId = rawModelId ? Number(rawModelId) : null;
        if (role === 'entry' && modelId === null) {
            alert.error(t('settings.general.modelPreferences.entryModelRequired'));
            await loadData();
            return;
        }

        try {
            await setModelRole({ role, modelId });
            await loadData();
            alert.success(t('common.saved'));
        } catch (error) {
            console.error('[ModelPreferences] Failed to save model role:', error);
            alert.error(t('settings.general.modelPreferences.saveFailed'));
            await loadData();
        }
    }

    async function savePreference(nextForm: PreferenceForm) {
        if (saving.value) {
            return;
        }

        const modelId = Number(nextForm.modelId);
        const selectedModel = Number.isFinite(modelId)
            ? models.value.find((model) => model.id === modelId && model.provider_enabled === 1)
            : null;
        if (!selectedModel) {
            alert.error(t('settings.general.modelPreferences.modelRequired'));
            return;
        }

        saving.value = true;
        try {
            const payload = {
                name: nextForm.name,
                description: nextForm.description,
                provider_id: selectedModel.provider_id,
                model_id: selectedModel.id,
            };

            if (nextForm.id === null) {
                await createModelPreference(payload);
            } else {
                await updateModelPreference(nextForm.id, payload);
            }

            form.value = null;
            await loadData();
            alert.success(t('common.saved'));
        } catch (error) {
            console.error('[ModelPreferences] Failed to save preference:', error);
            alert.error(t('settings.general.modelPreferences.saveFailed'));
        } finally {
            saving.value = false;
        }
    }

    async function removePreference(preference: ModelPreferenceWithModel) {
        try {
            await deleteModelPreference(preference.id);
            await loadData();
            alert.success(t('settings.ai.deleteSucceeded'));
        } catch (error) {
            console.error('[ModelPreferences] Failed to delete preference:', error);
            alert.error(t('settings.ai.deleteFailed'));
        }
    }

    onMounted(() => {
        void loadData();
    });
</script>

<template>
    <section class="space-y-4">
        <div>
            <h2 class="text-[15px] font-medium text-neutral-950">
                {{ t('settings.general.modelPreferences.title') }}
            </h2>
            <p class="mt-1 max-w-2xl text-sm leading-6 text-neutral-500">
                {{ t('settings.general.modelPreferences.description') }}
            </p>
        </div>

        <div class="settings-row-group divide-y divide-neutral-200/70">
            <div
                v-for="modelRole in modelRoles"
                :key="modelRole.role"
                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
            >
                <div class="min-w-0">
                    <div class="text-[13px] leading-6 font-normal text-neutral-900">
                        {{ t(modelRole.titleKey) }}
                    </div>
                    <p class="text-xs leading-5 text-neutral-500">
                        {{ t(modelRole.descriptionKey) }}
                    </p>
                </div>

                <div class="ml-auto w-full">
                    <CustomSelect
                        :model-value="getRoleModelValue(modelRole)"
                        :options="getRoleModelOptions(modelRole)"
                        :placeholder="t(modelRole.placeholderKey)"
                        protect-option-text
                        @update:model-value="updateRoleModel(modelRole.role, $event)"
                    />
                </div>
            </div>
        </div>
    </section>

    <section class="space-y-4 border-t border-neutral-200 pt-8">
        <div class="flex items-start justify-between gap-4">
            <div>
                <h2 class="text-[15px] font-medium text-neutral-950">
                    {{ t('settings.general.modelPreferences.scenarioPreferencesTitle') }}
                </h2>
                <p class="mt-1 max-w-2xl text-sm leading-6 text-neutral-500">
                    {{ t('settings.general.modelPreferences.scenarioPreferencesDescription') }}
                </p>
            </div>

            <button class="settings-button-primary flex items-center gap-1.5" @click="startCreate">
                <AppIcon name="plus" class="h-4 w-4" />
                {{ t('settings.general.modelPreferences.add') }}
            </button>
        </div>

        <div v-if="loading" class="settings-row-group px-4 py-3 text-sm text-neutral-500">
            {{ t('common.loading') }}
        </div>

        <div
            v-else-if="preferences.length === 0"
            class="rounded-[11px] border border-dashed border-neutral-200/80 bg-white px-4 py-5 text-center text-sm text-neutral-500"
        >
            {{ t('settings.general.modelPreferences.empty') }}
        </div>

        <div v-else class="settings-row-group divide-y divide-neutral-200/70">
            <div
                v-for="preference in preferences"
                :key="preference.id"
                class="flex items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-neutral-50/70"
            >
                <div class="min-w-0">
                    <h3 class="text-[13px] leading-5 font-medium text-neutral-950">
                        {{ preference.name }}
                    </h3>
                    <p class="mt-0.5 text-xs leading-5 text-neutral-600">
                        {{ preference.description }}
                    </p>
                    <p
                        :class="[
                            'mt-1 text-[11px] leading-4',
                            preference.provider_enabled === 1 && preference.model_id !== null
                                ? 'text-neutral-500'
                                : 'text-red-500',
                        ]"
                    >
                        {{
                            formatPreferenceModel(preference) ||
                            t('settings.general.modelPreferences.unavailableModel')
                        }}
                    </p>
                </div>

                <div class="flex shrink-0 gap-1 pt-0.5">
                    <button
                        class="settings-icon-button h-7 w-7 rounded-md"
                        :title="t('common.edit')"
                        @click="startEdit(preference)"
                    >
                        <AppIcon name="edit" class="h-3.5 w-3.5" />
                    </button>
                    <button
                        class="settings-icon-button h-7 w-7 rounded-md"
                        :title="t('common.delete')"
                        @click="removePreference(preference)"
                    >
                        <AppIcon name="delete" class="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
        </div>

        <ModelPreferenceDialog
            v-if="form"
            :preference="form"
            :models="models"
            :saving="saving"
            @save="savePreference"
            @cancel="cancelEdit"
        />
    </section>
</template>
