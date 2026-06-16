<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import ModelCapabilityTags from '@components/ModelCapabilityTags.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import SearchableSelect from '@components/SearchableSelect.vue';
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

    interface Props {
        routingEnabled?: boolean;
    }

    withDefaults(defineProps<Props>(), {
        routingEnabled: true,
    });

    interface PreferenceForm {
        id: number | null;
        name: string;
        description: string;
        modelId: string;
    }

    interface ModelPreferenceSelectOption {
        value: string | number;
        label: string;
        description?: string;
        searchText?: string;
        providerLogo?: string;
        providerName?: string;
        modelIdForLogo?: string;
        modelName?: string;
        attachment?: number | null;
        modalities?: string | null;
        open_weights?: number | null;
        reasoning?: number | null;
        tool_call?: number | null;
    }

    const alert = useAlert();
    const loading = ref(true);
    const saving = ref(false);
    const preferences = ref<ModelPreferenceWithModel[]>([]);
    const models = ref<ModelWithProvider[]>([]);
    const savingPreferenceIds = ref<Set<number>>(new Set());
    const roleModelIds = ref<Record<ModelRole, string>>({
        entry: '',
        fast: '',
        general: '',
    });
    const roleProviderIds = ref<Record<ModelRole, number | null>>({
        entry: null,
        fast: null,
        general: null,
    });
    const form = ref<PreferenceForm | null>(null);
    const UNSET_MODEL_VALUE = '__touchai_unset_model__';
    const rawProviderLogos = import.meta.glob<{ default: string }>('@assets/logos/providers/*', {
        eager: true,
    });
    const providerLogos: Record<string, string> = {};
    for (const [path, mod] of Object.entries(rawProviderLogos)) {
        const fileName = path.split('/').pop();
        if (fileName && mod.default) {
            providerLogos[fileName] = mod.default;
        }
    }

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

    const enabledModels = computed(() =>
        [...models.value]
            .sort(
                (left, right) =>
                    left.provider_name.localeCompare(right.provider_name) ||
                    left.name.localeCompare(right.name) ||
                    left.model_id.localeCompare(right.model_id)
            )
            .filter((model) => model.provider_enabled === 1)
    );

    const providerOptions = computed<ModelPreferenceSelectOption[]>(() => {
        const providerMap = new Map<number, ModelPreferenceSelectOption>();

        for (const model of enabledModels.value) {
            if (providerMap.has(model.provider_id)) {
                continue;
            }

            const providerModelCount = enabledModels.value.filter(
                (item) => item.provider_id === model.provider_id
            ).length;
            providerMap.set(model.provider_id, {
                value: model.provider_id,
                label: model.provider_name,
                description: t('settings.builtInTools.upgradeModel.availableModelCount', {
                    count: providerModelCount,
                }),
                searchText: `${model.provider_name} ${model.provider_driver}`,
                providerLogo: model.provider_logo,
                providerName: model.provider_name,
            });
        }

        return [...providerMap.values()];
    });

    function getRoleProviderOptions(
        modelRole: (typeof modelRoles)[number]
    ): ModelPreferenceSelectOption[] {
        if (modelRole.required) {
            return providerOptions.value;
        }

        return [
            {
                value: UNSET_MODEL_VALUE,
                label: t(modelRole.placeholderKey),
            },
            ...providerOptions.value,
        ];
    }

    function getRoleProviderValue(modelRole: (typeof modelRoles)[number]): string | number | null {
        const providerId = roleProviderIds.value[modelRole.role];
        if (!modelRole.required && !roleModelIds.value[modelRole.role]) {
            return UNSET_MODEL_VALUE;
        }

        return providerId;
    }

    function getRoleModelOptions(role: ModelRole): ModelPreferenceSelectOption[] {
        const providerId = roleProviderIds.value[role];
        if (providerId === null) {
            return [];
        }

        return getModelOptionsForProvider(providerId);
    }

    function getModelOptionsForProvider(providerId: number): ModelPreferenceSelectOption[] {
        return enabledModels.value
            .filter((model) => model.provider_id === providerId)
            .map((model) => ({
                value: String(model.id),
                label: model.name,
                description: model.model_id,
                searchText: `${model.provider_name} ${model.name} ${model.model_id}`,
                modelIdForLogo: model.model_id,
                modelName: model.name,
                providerName: model.provider_name,
                attachment: model.attachment,
                modalities: model.modalities,
                open_weights: model.open_weights,
                reasoning: model.reasoning,
                tool_call: model.tool_call,
            }));
    }

    function getRoleModelValue(role: ModelRole): string | null {
        return roleModelIds.value[role] || null;
    }

    function resolveProviderLogoPath(logo?: string): string {
        return (logo && providerLogos[logo]) || '';
    }

    function getProviderFallbackText(option: ModelPreferenceSelectOption | null): string {
        return option?.label?.charAt(0) || '?';
    }

    function updateRoleProvider(modelRole: (typeof modelRoles)[number], value: string | number) {
        if (!modelRole.required && value === UNSET_MODEL_VALUE) {
            roleProviderIds.value[modelRole.role] = null;
            roleModelIds.value[modelRole.role] = '';
            void saveModelRole(modelRole.role);
            return;
        }

        const providerId = Number(value);
        if (!Number.isInteger(providerId)) {
            return;
        }

        roleProviderIds.value[modelRole.role] = providerId;

        const currentModel = enabledModels.value.find(
            (model) =>
                String(model.id) === roleModelIds.value[modelRole.role] &&
                model.provider_id === providerId
        );
        const nextModel =
            currentModel ?? enabledModels.value.find((model) => model.provider_id === providerId);

        roleModelIds.value[modelRole.role] = nextModel ? String(nextModel.id) : '';
        void saveModelRole(modelRole.role);
    }

    function updateRoleModel(role: ModelRole, value: string | number) {
        roleModelIds.value[role] = String(value);
        const selectedModel = enabledModels.value.find(
            (model) => String(model.id) === String(value)
        );
        roleProviderIds.value[role] = selectedModel?.provider_id ?? roleProviderIds.value[role];
        void saveModelRole(role);
    }

    function getPreferenceProviderValue(preference: ModelPreferenceWithModel): number | null {
        return preference.model_provider_id ?? preference.provider_id ?? null;
    }

    function getPreferenceModelValue(preference: ModelPreferenceWithModel): string | null {
        return preference.model_id === null ? null : String(preference.model_id);
    }

    function getPreferenceModelOptions(preference: ModelPreferenceWithModel) {
        const providerId = getPreferenceProviderValue(preference);
        return providerId === null ? [] : getModelOptionsForProvider(providerId);
    }

    function isPreferenceSaving(preferenceId: number): boolean {
        return savingPreferenceIds.value.has(preferenceId);
    }

    function setPreferenceSaving(preferenceId: number, nextSaving: boolean) {
        const nextIds = new Set(savingPreferenceIds.value);
        if (nextSaving) {
            nextIds.add(preferenceId);
        } else {
            nextIds.delete(preferenceId);
        }
        savingPreferenceIds.value = nextIds;
    }

    async function updatePreferenceModel(preference: ModelPreferenceWithModel, modelId: string) {
        if (isPreferenceSaving(preference.id)) {
            return;
        }

        const selectedModel = enabledModels.value.find((model) => String(model.id) === modelId);
        if (!selectedModel) {
            alert.error(t('settings.general.modelPreferences.modelRequired'));
            await loadData();
            return;
        }

        setPreferenceSaving(preference.id, true);
        try {
            await updateModelPreference(preference.id, {
                provider_id: selectedModel.provider_id,
                model_id: selectedModel.id,
            });
            await loadData();
            alert.success(t('common.saved'));
        } catch (error) {
            console.error('[ModelPreferences] Failed to update preference model:', error);
            alert.error(t('settings.general.modelPreferences.saveFailed'));
            await loadData();
        } finally {
            setPreferenceSaving(preference.id, false);
        }
    }

    function updatePreferenceProvider(
        preference: ModelPreferenceWithModel,
        value: string | number
    ) {
        const providerId = Number(value);
        if (!Number.isInteger(providerId)) {
            return;
        }

        const currentModel = enabledModels.value.find(
            (model) =>
                preference.model_id !== null &&
                model.id === preference.model_id &&
                model.provider_id === providerId
        );
        const nextModel =
            currentModel ?? enabledModels.value.find((model) => model.provider_id === providerId);

        if (!nextModel) {
            alert.error(t('settings.general.modelPreferences.modelRequired'));
            return;
        }

        void updatePreferenceModel(preference, String(nextModel.id));
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
            const [nextPreferences, nextModels, defaultRoleModel, fastModel, generalModel] =
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
                entry: defaultRoleModel ? String(defaultRoleModel.id) : '',
                fast: fastModel ? String(fastModel.id) : '',
                general: generalModel ? String(generalModel.id) : '',
            };
            roleProviderIds.value = {
                entry: defaultRoleModel?.provider_id ?? null,
                fast: fastModel?.provider_id ?? null,
                general: generalModel?.provider_id ?? null,
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
    <div v-if="loading" class="settings-row-group px-4 py-3 text-sm text-neutral-500">
        {{ t('common.loading') }}
    </div>

    <div
        v-else-if="models.length === 0"
        class="rounded-[11px] border border-dashed border-neutral-200/80 bg-white px-6 py-12 text-center"
    >
        <AppIcon name="cloud" class="mx-auto h-10 w-10 text-neutral-300" />
        <h2 class="mt-4 text-[15px] font-medium text-neutral-950">
            {{ t('settings.general.modelPreferences.noModelsTitle') }}
        </h2>
        <p class="mx-auto mt-2 max-w-md text-sm leading-6 text-neutral-500">
            {{ t('settings.general.modelPreferences.noModelsDescription') }}
        </p>
    </div>

    <fieldset v-else :disabled="!routingEnabled" class="contents">
        <section class="space-y-4">
            <h2 class="settings-section-title">
                {{ t('settings.general.modelPreferences.rolesTitle') }}
            </h2>

            <div
                class="settings-row-group relative z-10 divide-y divide-neutral-200/70 overflow-visible"
            >
                <div
                    v-for="modelRole in modelRoles"
                    :key="modelRole.role"
                    class="grid min-w-0 gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,520px)] md:items-center"
                >
                    <div class="min-w-0">
                        <div class="text-[13px] leading-6 font-normal text-neutral-900">
                            {{ t(modelRole.titleKey) }}
                        </div>
                        <p class="text-xs leading-5 text-neutral-500">
                            {{ t(modelRole.descriptionKey) }}
                        </p>
                    </div>

                    <div
                        class="ml-auto grid w-full min-w-0 gap-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.15fr)]"
                    >
                        <SearchableSelect
                            :model-value="getRoleProviderValue(modelRole)"
                            :options="getRoleProviderOptions(modelRole)"
                            placeholder-key="settings.builtInTools.upgradeModel.provider"
                            search-placeholder-key="settings.builtInTools.upgradeModel.searchProvider"
                            empty-text-key="settings.builtInTools.upgradeModel.emptyProviders"
                            protect-option-text
                            @update:model-value="updateRoleProvider(modelRole, $event)"
                        >
                            <template #selected="{ option }">
                                <div class="flex min-w-0 items-center gap-2">
                                    <img
                                        v-if="resolveProviderLogoPath(option?.providerLogo)"
                                        :src="resolveProviderLogoPath(option?.providerLogo)"
                                        :alt="option?.providerName || option?.label || 'provider'"
                                        class="h-5 w-5 flex-shrink-0 rounded object-contain"
                                        data-no-i18n="true"
                                        translate="no"
                                    />
                                    <div
                                        v-else-if="option?.value !== UNSET_MODEL_VALUE"
                                        class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-neutral-100 text-[10px] font-semibold text-neutral-500"
                                        data-no-i18n="true"
                                        translate="no"
                                    >
                                        {{ getProviderFallbackText(option) }}
                                    </div>
                                    <span
                                        v-if="option"
                                        class="truncate"
                                        :data-no-i18n="
                                            option.value === UNSET_MODEL_VALUE ? undefined : 'true'
                                        "
                                        :translate="
                                            option.value === UNSET_MODEL_VALUE ? undefined : 'no'
                                        "
                                    >
                                        {{ option.label }}
                                    </span>
                                    <span v-else class="truncate">
                                        {{ t('settings.builtInTools.upgradeModel.provider') }}
                                    </span>
                                </div>
                            </template>

                            <template #option="{ option }">
                                <div class="flex min-w-0 items-center gap-2">
                                    <img
                                        v-if="resolveProviderLogoPath(option.providerLogo)"
                                        :src="resolveProviderLogoPath(option.providerLogo)"
                                        :alt="option.providerName || option.label"
                                        class="h-5 w-5 flex-shrink-0 rounded object-contain"
                                        data-no-i18n="true"
                                        translate="no"
                                    />
                                    <div
                                        v-else-if="option.value !== UNSET_MODEL_VALUE"
                                        class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-neutral-100 text-[10px] font-semibold text-neutral-500"
                                        data-no-i18n="true"
                                        translate="no"
                                    >
                                        {{ getProviderFallbackText(option) }}
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <div
                                            class="truncate text-sm font-medium"
                                            :data-no-i18n="
                                                option.value === UNSET_MODEL_VALUE
                                                    ? undefined
                                                    : 'true'
                                            "
                                            :translate="
                                                option.value === UNSET_MODEL_VALUE
                                                    ? undefined
                                                    : 'no'
                                            "
                                        >
                                            {{ option.label }}
                                        </div>
                                        <div
                                            v-if="option.description"
                                            class="mt-0.5 truncate text-xs text-neutral-500"
                                            data-no-i18n="true"
                                            translate="no"
                                        >
                                            {{ option.description }}
                                        </div>
                                    </div>
                                </div>
                            </template>
                        </SearchableSelect>

                        <SearchableSelect
                            :model-value="getRoleModelValue(modelRole.role)"
                            :options="getRoleModelOptions(modelRole.role)"
                            :disabled="!roleProviderIds[modelRole.role]"
                            placeholder-key="settings.builtInTools.upgradeModel.model"
                            search-placeholder-key="settings.builtInTools.upgradeModel.searchModel"
                            empty-text-key="settings.builtInTools.upgradeModel.emptyModels"
                            protect-option-text
                            @update:model-value="updateRoleModel(modelRole.role, $event)"
                        >
                            <template #selected="{ option }">
                                <div class="flex min-w-0 items-center gap-2">
                                    <ModelLogo
                                        v-if="option?.modelIdForLogo"
                                        :model-id="option.modelIdForLogo"
                                        :name="option.modelName || option.label"
                                        size="sm"
                                    />
                                    <span
                                        v-if="option"
                                        class="truncate"
                                        data-no-i18n="true"
                                        translate="no"
                                    >
                                        {{ option.label }}
                                    </span>
                                    <span v-else class="truncate">
                                        {{ t('settings.builtInTools.upgradeModel.model') }}
                                    </span>
                                </div>
                            </template>

                            <template #option="{ option }">
                                <div class="flex min-w-0 items-center gap-2">
                                    <ModelLogo
                                        v-if="option.modelIdForLogo"
                                        :model-id="option.modelIdForLogo"
                                        :name="option.modelName || option.label"
                                        size="sm"
                                    />
                                    <div class="min-w-0 flex-1">
                                        <div
                                            class="truncate text-sm font-medium"
                                            data-no-i18n="true"
                                            translate="no"
                                        >
                                            {{ option.label }}
                                        </div>
                                        <div class="mt-1">
                                            <ModelCapabilityTags
                                                v-if="
                                                    option.reasoning !== undefined ||
                                                    option.tool_call !== undefined ||
                                                    option.modalities !== undefined ||
                                                    option.attachment !== undefined ||
                                                    option.open_weights !== undefined
                                                "
                                                :model="option"
                                                size="sm"
                                            />
                                            <div
                                                v-else-if="option.description"
                                                class="truncate text-xs text-neutral-500"
                                                data-no-i18n="true"
                                                translate="no"
                                            >
                                                {{ option.description }}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </template>
                        </SearchableSelect>
                    </div>
                </div>
            </div>
        </section>

        <section class="space-y-4 pt-5">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <h2 class="text-[15px] font-medium text-neutral-950">
                        {{ t('settings.general.modelPreferences.scenarioPreferencesTitle') }}
                    </h2>
                    <p class="mt-1 max-w-2xl text-sm leading-6 text-neutral-500">
                        {{ t('settings.general.modelPreferences.scenarioPreferencesDescription') }}
                    </p>
                </div>

                <button
                    class="settings-button-primary flex items-center gap-1.5"
                    @click="startCreate"
                >
                    <AppIcon name="plus" class="h-4 w-4" />
                    {{ t('settings.general.modelPreferences.add') }}
                </button>
            </div>

            <div
                v-if="preferences.length === 0"
                class="rounded-[11px] border border-dashed border-neutral-200/80 bg-white px-4 py-5 text-center text-sm text-neutral-500"
            >
                {{ t('settings.general.modelPreferences.empty') }}
            </div>

            <div
                v-else
                class="settings-row-group relative z-0 divide-y divide-neutral-200/70 overflow-visible"
            >
                <div
                    v-for="preference in preferences"
                    :key="preference.id"
                    class="grid min-w-0 gap-4 px-4 py-3 transition-colors hover:bg-neutral-50/70 md:grid-cols-[minmax(0,1fr)_minmax(0,520px)] md:items-center"
                >
                    <div class="min-w-0">
                        <div class="flex min-w-0 items-center gap-1.5">
                            <h3 class="truncate text-[13px] leading-5 font-medium text-neutral-950">
                                {{ preference.name }}
                            </h3>
                            <button
                                class="settings-icon-button h-6 w-6 rounded-md"
                                :title="t('common.edit')"
                                @click="startEdit(preference)"
                            >
                                <AppIcon name="edit" class="h-3.5 w-3.5" />
                            </button>
                            <button
                                class="settings-icon-button h-6 w-6 rounded-md"
                                :title="t('common.delete')"
                                @click="removePreference(preference)"
                            >
                                <AppIcon name="delete" class="h-3.5 w-3.5" />
                            </button>
                        </div>
                        <p class="mt-0.5 text-xs leading-5 text-neutral-600">
                            {{ preference.description }}
                        </p>
                        <p
                            v-if="preference.provider_enabled !== 1 || preference.model_id === null"
                            class="mt-1 text-[11px] leading-4 text-red-500"
                        >
                            {{ t('settings.general.modelPreferences.unavailableModel') }}
                        </p>
                    </div>

                    <div
                        class="ml-auto grid w-full min-w-0 gap-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.15fr)]"
                    >
                        <SearchableSelect
                            :model-value="getPreferenceProviderValue(preference)"
                            :options="providerOptions"
                            :disabled="isPreferenceSaving(preference.id)"
                            placeholder-key="settings.builtInTools.upgradeModel.provider"
                            search-placeholder-key="settings.builtInTools.upgradeModel.searchProvider"
                            empty-text-key="settings.builtInTools.upgradeModel.emptyProviders"
                            protect-option-text
                            @update:model-value="updatePreferenceProvider(preference, $event)"
                        >
                            <template #selected="{ option }">
                                <div class="flex min-w-0 items-center gap-2">
                                    <img
                                        v-if="resolveProviderLogoPath(option?.providerLogo)"
                                        :src="resolveProviderLogoPath(option?.providerLogo)"
                                        :alt="option?.providerName || option?.label || 'provider'"
                                        class="h-5 w-5 flex-shrink-0 rounded object-contain"
                                        data-no-i18n="true"
                                        translate="no"
                                    />
                                    <div
                                        v-else
                                        class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-neutral-100 text-[10px] font-semibold text-neutral-500"
                                        data-no-i18n="true"
                                        translate="no"
                                    >
                                        {{ getProviderFallbackText(option) }}
                                    </div>
                                    <span
                                        v-if="option"
                                        class="truncate"
                                        data-no-i18n="true"
                                        translate="no"
                                    >
                                        {{ option.label }}
                                    </span>
                                    <span v-else class="truncate">
                                        {{ t('settings.builtInTools.upgradeModel.provider') }}
                                    </span>
                                </div>
                            </template>

                            <template #option="{ option }">
                                <div class="flex min-w-0 items-center gap-2">
                                    <img
                                        v-if="resolveProviderLogoPath(option.providerLogo)"
                                        :src="resolveProviderLogoPath(option.providerLogo)"
                                        :alt="option.providerName || option.label"
                                        class="h-5 w-5 flex-shrink-0 rounded object-contain"
                                        data-no-i18n="true"
                                        translate="no"
                                    />
                                    <div
                                        v-else
                                        class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-neutral-100 text-[10px] font-semibold text-neutral-500"
                                        data-no-i18n="true"
                                        translate="no"
                                    >
                                        {{ getProviderFallbackText(option) }}
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <div
                                            class="truncate text-sm font-medium"
                                            data-no-i18n="true"
                                            translate="no"
                                        >
                                            {{ option.label }}
                                        </div>
                                        <div
                                            v-if="option.description"
                                            class="mt-0.5 truncate text-xs text-neutral-500"
                                            data-no-i18n="true"
                                            translate="no"
                                        >
                                            {{ option.description }}
                                        </div>
                                    </div>
                                </div>
                            </template>
                        </SearchableSelect>

                        <SearchableSelect
                            :model-value="getPreferenceModelValue(preference)"
                            :options="getPreferenceModelOptions(preference)"
                            :disabled="
                                isPreferenceSaving(preference.id) ||
                                getPreferenceProviderValue(preference) === null
                            "
                            placeholder-key="settings.builtInTools.upgradeModel.model"
                            search-placeholder-key="settings.builtInTools.upgradeModel.searchModel"
                            empty-text-key="settings.builtInTools.upgradeModel.emptyModels"
                            protect-option-text
                            @update:model-value="updatePreferenceModel(preference, String($event))"
                        >
                            <template #selected="{ option }">
                                <div class="flex min-w-0 items-center gap-2">
                                    <ModelLogo
                                        v-if="option?.modelIdForLogo"
                                        :model-id="option.modelIdForLogo"
                                        :name="option.modelName || option.label"
                                        size="sm"
                                    />
                                    <span
                                        v-if="option"
                                        class="truncate"
                                        data-no-i18n="true"
                                        translate="no"
                                    >
                                        {{ option.label }}
                                    </span>
                                    <span v-else class="truncate">
                                        {{ t('settings.builtInTools.upgradeModel.model') }}
                                    </span>
                                </div>
                            </template>

                            <template #option="{ option }">
                                <div class="flex min-w-0 items-center gap-2">
                                    <ModelLogo
                                        v-if="option.modelIdForLogo"
                                        :model-id="option.modelIdForLogo"
                                        :name="option.modelName || option.label"
                                        size="sm"
                                    />
                                    <div class="min-w-0 flex-1">
                                        <div
                                            class="truncate text-sm font-medium"
                                            data-no-i18n="true"
                                            translate="no"
                                        >
                                            {{ option.label }}
                                        </div>
                                        <div class="mt-1">
                                            <ModelCapabilityTags
                                                v-if="
                                                    option.reasoning !== undefined ||
                                                    option.tool_call !== undefined ||
                                                    option.modalities !== undefined ||
                                                    option.attachment !== undefined ||
                                                    option.open_weights !== undefined
                                                "
                                                :model="option"
                                                size="sm"
                                            />
                                            <div
                                                v-else-if="option.description"
                                                class="truncate text-xs text-neutral-500"
                                                data-no-i18n="true"
                                                translate="no"
                                            >
                                                {{ option.description }}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </template>
                        </SearchableSelect>
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
    </fieldset>
</template>
