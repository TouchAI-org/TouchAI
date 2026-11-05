<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import EmptyState from '@components/EmptyState.vue';
    import LoadingState from '@components/LoadingState.vue';
    import SearchableSelect from '@components/SearchableSelect.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { Switch } from '@components/ui/switch';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import {
        createModelPreference,
        deleteModelPreference,
        findModelRoleWithProvider,
        findModelsWithProvider,
        listModelPreferences,
        setModelRole,
        updateModelPreference,
    } from '@database/queries';
    import type { ModelWithProvider } from '@database/queries/models';
    import type { ModelPreferenceWithModel, ModelRole } from '@database/types';
    import { AppEvent, eventService } from '@services/EventService';
    import { log } from '@services/ObservabilityService';
    import { storeToRefs } from 'pinia';
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';

    import ModelPreferenceDialog, { type ModelPreferenceForm } from './ModelPreferenceDialog.vue';

    defineOptions({
        name: 'SettingsModelPreferencesSection',
    });

    interface ModelOption {
        value: string;
        label: string;
        description: string;
        searchText: string;
    }

    interface RoleDefinition {
        role: ModelRole;
        required: boolean;
        labelKey: MessageKey;
        descriptionKey: MessageKey;
        placeholderKey: MessageKey;
    }

    const UNSET_MODEL_VALUE = '__touchai_unset_model__';

    const ROLE_DEFINITIONS: RoleDefinition[] = [
        {
            role: 'entry',
            required: true,
            labelKey: 'settings.modelRouting.entryModel',
            descriptionKey: 'settings.modelRouting.entryModelDescription',
            placeholderKey: 'settings.modelRouting.selectEntryModel',
        },
        {
            role: 'fast',
            required: false,
            labelKey: 'settings.modelRouting.fastModel',
            descriptionKey: 'settings.modelRouting.fastModelDescription',
            placeholderKey: 'settings.modelRouting.useDefaultModel',
        },
        {
            role: 'general',
            required: false,
            labelKey: 'settings.modelRouting.generalModel',
            descriptionKey: 'settings.modelRouting.generalModelDescription',
            placeholderKey: 'settings.modelRouting.useDefaultModel',
        },
    ];

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);
    const alert = useAlert();
    const { confirm } = useConfirm();

    const loading = ref(true);
    const error = ref<string | null>(null);
    const models = ref<ModelWithProvider[]>([]);
    const preferences = ref<ModelPreferenceWithModel[]>([]);
    const roleModelIds = ref<Record<ModelRole, string>>({
        entry: '',
        fast: '',
        general: '',
    });
    const savingRoles = ref<Set<ModelRole>>(new Set());
    const routingSaving = ref(false);
    const dialogOpen = ref(false);
    const editingPreference = ref<ModelPreferenceForm | null>(null);
    const savingPreference = ref(false);
    let unlistenModelsUpdated: (() => void) | null = null;
    let unmounted = false;

    const enabledModels = computed(() =>
        models.value
            .filter((model) => model.provider_enabled === 1)
            .slice()
            .sort(
                (left, right) =>
                    left.provider_name.localeCompare(right.provider_name) ||
                    left.name.localeCompare(right.name) ||
                    left.model_id.localeCompare(right.model_id)
            )
    );

    const modelOptions = computed<ModelOption[]>(() =>
        enabledModels.value.map((model) => ({
            value: String(model.id),
            label: `${model.provider_name} / ${model.name}`,
            description: model.model_id,
            searchText: `${model.provider_name} ${model.name} ${model.model_id}`,
        }))
    );

    const enabledModelIds = computed(() => new Set(enabledModels.value.map((model) => model.id)));

    function roleOptions(definition: RoleDefinition): ModelOption[] {
        if (definition.required) {
            return modelOptions.value;
        }

        return [
            {
                value: UNSET_MODEL_VALUE,
                label: t('settings.modelRouting.useDefaultModel'),
                description: '',
                searchText: t('settings.modelRouting.useDefaultModel'),
            },
            ...modelOptions.value,
        ];
    }

    function roleValue(definition: RoleDefinition): string {
        const modelId = roleModelIds.value[definition.role];
        return modelId || (definition.required ? '' : UNSET_MODEL_VALUE);
    }

    function isSavingRole(role: ModelRole): boolean {
        return savingRoles.value.has(role);
    }

    function setRoleSaving(role: ModelRole, saving: boolean) {
        const next = new Set(savingRoles.value);
        if (saving) {
            next.add(role);
        } else {
            next.delete(role);
        }
        savingRoles.value = next;
    }

    async function loadRoles() {
        const [entry, fast, general] = await Promise.all([
            findModelRoleWithProvider('entry'),
            findModelRoleWithProvider('fast'),
            findModelRoleWithProvider('general'),
        ]);
        roleModelIds.value = {
            entry: entry ? String(entry.id) : '',
            fast: fast ? String(fast.id) : '',
            general: general ? String(general.id) : '',
        };
    }

    async function loadData() {
        loading.value = true;
        error.value = null;
        try {
            const [nextModels, nextPreferences] = await Promise.all([
                findModelsWithProvider(),
                listModelPreferences(),
                loadRoles(),
            ]);
            models.value = nextModels;
            preferences.value = nextPreferences;
        } catch (loadError) {
            log.error('[ModelPreferences] Failed to load model routing:', loadError);
            error.value = loadError instanceof Error ? loadError.message : String(loadError);
            alert.error(t('settings.modelRouting.loadFailed'));
        } finally {
            loading.value = false;
        }
    }

    async function updateRouting(enabled: boolean) {
        if (routingSaving.value) {
            return;
        }

        routingSaving.value = true;
        try {
            await settingsStore.updateAllowModelAutoSwitch(enabled);
        } catch (saveError) {
            log.error('[ModelPreferences] Failed to save model routing switch:', saveError);
            alert.error(t('settings.modelRouting.saveFailed'));
        } finally {
            routingSaving.value = false;
        }
    }

    async function updateRoleModel(definition: RoleDefinition, value: string) {
        if (isSavingRole(definition.role)) {
            return;
        }

        const previousModelId = roleModelIds.value[definition.role];
        const nextModelId = value === UNSET_MODEL_VALUE ? '' : String(value);
        if (nextModelId === previousModelId) {
            return;
        }

        roleModelIds.value = {
            ...roleModelIds.value,
            [definition.role]: nextModelId,
        };
        setRoleSaving(definition.role, true);
        try {
            await setModelRole({
                role: definition.role,
                modelId: nextModelId ? Number(nextModelId) : null,
            });
            alert.success(t('common.saved'), 2000);
        } catch (saveError) {
            roleModelIds.value = {
                ...roleModelIds.value,
                [definition.role]: previousModelId,
            };
            log.error('[ModelPreferences] Failed to save model role:', saveError);
            alert.error(
                saveError instanceof Error
                    ? saveError.message
                    : t('settings.modelRouting.saveFailed')
            );
        } finally {
            setRoleSaving(definition.role, false);
        }
    }

    function isPreferenceAvailable(preference: ModelPreferenceWithModel): boolean {
        return (
            preference.model_id !== null &&
            preference.provider_enabled === 1 &&
            enabledModelIds.value.has(preference.model_id)
        );
    }

    function preferenceModelLabel(preference: ModelPreferenceWithModel): string {
        return [preference.provider_name, preference.model_name].filter(Boolean).join(' / ');
    }

    function openCreateDialog() {
        editingPreference.value = {
            id: null,
            name: '',
            description: '',
            modelId: modelOptions.value[0]?.value ?? '',
        };
        dialogOpen.value = true;
    }

    function openEditDialog(preference: ModelPreferenceWithModel) {
        editingPreference.value = {
            id: preference.id,
            name: preference.name,
            description: preference.description,
            modelId: preference.model_id === null ? '' : String(preference.model_id),
        };
        dialogOpen.value = true;
    }

    function closeDialog() {
        if (savingPreference.value) {
            return;
        }
        dialogOpen.value = false;
        editingPreference.value = null;
    }

    async function savePreference(form: ModelPreferenceForm) {
        if (savingPreference.value) {
            return;
        }

        const modelId = Number(form.modelId);
        if (!Number.isInteger(modelId) || modelId <= 0) {
            alert.error(t('settings.modelRouting.modelRequired'));
            return;
        }

        savingPreference.value = true;
        try {
            const payload = {
                name: form.name,
                description: form.description,
                model_id: modelId,
            };
            if (form.id === null) {
                await createModelPreference(payload);
            } else {
                await updateModelPreference(form.id, payload);
            }
            dialogOpen.value = false;
            editingPreference.value = null;
            await loadData();
            alert.success(t('common.saved'), 2000);
        } catch (saveError) {
            log.error('[ModelPreferences] Failed to save preference:', saveError);
            alert.error(
                saveError instanceof Error
                    ? saveError.message
                    : t('settings.modelRouting.saveFailed')
            );
        } finally {
            savingPreference.value = false;
        }
    }

    async function removePreference(preference: ModelPreferenceWithModel) {
        const confirmed = await confirm({
            title: t('settings.modelRouting.deleteConfirmTitle'),
            message: t('settings.modelRouting.deleteConfirmMessage', { name: preference.name }),
            type: 'danger',
        });
        if (!confirmed) {
            return;
        }

        try {
            await deleteModelPreference(preference.id);
            await loadData();
            alert.success(t('settings.ai.deleteSucceeded'), 2000);
        } catch (deleteError) {
            log.error('[ModelPreferences] Failed to delete preference:', deleteError);
            alert.error(t('settings.modelRouting.deleteFailed'));
        }
    }

    onMounted(async () => {
        const settingsPromise = settingsStore.initialize().catch((settingsError) => {
            log.error('[ModelPreferences] Failed to initialize settings:', settingsError);
            alert.error(t('settings.general.loadSettingsFailed'));
        });
        await Promise.all([settingsPromise, loadData()]);

        const unlisten = await eventService.on(AppEvent.AI_MODELS_UPDATED, async () => {
            if (unmounted) {
                return;
            }
            await loadData();
        });
        if (unmounted) {
            unlisten();
        } else {
            unlistenModelsUpdated = unlisten;
        }
    });

    onBeforeUnmount(() => {
        unmounted = true;
        unlistenModelsUpdated?.();
        unlistenModelsUpdated = null;
    });
</script>

<template>
    <LoadingState v-if="loading" variant="brand" fill="min" />

    <div v-else class="settings-page" data-testid="settings-model-preferences-section">
        <div class="settings-section-stack">
            <header class="settings-page-header flex items-start gap-4">
                <div class="max-w-2xl min-w-0">
                    <h1 class="settings-page-title">
                        {{ t('settings.nav.modelPreferences.label') }}
                    </h1>
                    <p class="settings-section-description">
                        {{ t('settings.modelRouting.routingDescription') }}
                    </p>
                </div>
                <Switch
                    size="lg"
                    class="ml-auto shrink-0"
                    data-testid="model-routing-toggle"
                    data-settings-search-target="model-routing-enabled"
                    :aria-label="t('settings.modelRouting.enableRouting')"
                    :model-value="settings.allowModelAutoSwitch"
                    :disabled="routingSaving"
                    @update:model-value="updateRouting"
                />
            </header>

            <div v-if="error" class="settings-card text-text-secondary">
                <p class="font-medium text-text-primary">
                    {{ t('settings.modelRouting.loadFailed') }}
                </p>
                <p class="mt-1 text-sm">{{ error }}</p>
                <Button variant="strong" class="mt-4" @click="loadData">
                    {{ t('common.retry') }}
                </Button>
            </div>

            <EmptyState
                v-else-if="enabledModels.length === 0"
                :title="t('settings.modelRouting.noModelsTitle')"
                :description="t('settings.modelRouting.noModelsDescription')"
                icon="llm"
            />

            <template v-else>
                <section class="space-y-4">
                    <h2 class="settings-section-title">
                        {{ t('settings.modelRouting.rolesTitle') }}
                    </h2>

                    <div class="settings-row-group divide-y divide-border-subtle">
                        <SettingsRow
                            v-for="definition in ROLE_DEFINITIONS"
                            :key="definition.role"
                            :data-settings-search-target="`model-routing-${definition.role}`"
                            control-width="320"
                            :label="t(definition.labelKey)"
                            :description="t(definition.descriptionKey)"
                        >
                            <SearchableSelect
                                :data-testid="`model-routing-${definition.role}-select`"
                                :model-value="roleValue(definition)"
                                :options="roleOptions(definition)"
                                :placeholder-key="definition.placeholderKey"
                                :search-placeholder-key="'settings.modelRouting.selectModel'"
                                :empty-text-key="'settings.modelRouting.noModelsTitle'"
                                :disabled="isSavingRole(definition.role)"
                                protect-option-text
                                @update:model-value="updateRoleModel(definition, $event)"
                            />
                        </SettingsRow>
                    </div>
                </section>

                <section class="space-y-4" data-settings-search-target="model-routing-scenarios">
                    <div class="flex items-start justify-between gap-4">
                        <div class="min-w-0">
                            <h2 class="settings-section-title">
                                {{ t('settings.modelRouting.scenarioTitle') }}
                            </h2>
                            <p class="settings-section-description">
                                {{ t('settings.modelRouting.scenarioDescription') }}
                            </p>
                        </div>
                        <Button
                            variant="strong"
                            data-testid="model-routing-add"
                            @click="openCreateDialog"
                        >
                            {{ t('settings.modelRouting.addPreference') }}
                        </Button>
                    </div>

                    <div v-if="preferences.length === 0" class="settings-row-group">
                        <EmptyState
                            :title="t('settings.modelRouting.empty')"
                            icon="route"
                            size="compact"
                        />
                    </div>

                    <div v-else class="settings-row-group divide-y divide-border-subtle">
                        <div
                            v-for="preference in preferences"
                            :key="preference.id"
                            class="flex min-w-0 items-start gap-4 px-5 py-4"
                            :data-testid="`model-routing-preference-${preference.id}`"
                        >
                            <div class="min-w-0 flex-1">
                                <p class="text-compact font-medium text-text-primary">
                                    {{ preference.name }}
                                </p>
                                <p class="mt-1 text-xs leading-5 text-text-secondary">
                                    {{ preference.description }}
                                </p>
                                <p
                                    v-if="isPreferenceAvailable(preference)"
                                    class="mt-2 text-xs text-text-tertiary"
                                    data-testid="model-routing-preference-model"
                                >
                                    {{ preferenceModelLabel(preference) }}
                                </p>
                                <p
                                    v-else
                                    class="mt-2 text-xs text-text-danger"
                                    data-testid="model-routing-preference-unavailable"
                                >
                                    {{ t('settings.modelRouting.unavailableModel') }}
                                </p>
                            </div>
                            <div class="flex shrink-0 items-center gap-1">
                                <Button
                                    variant="ghost-neutral"
                                    :title="t('common.edit')"
                                    :aria-label="t('common.edit')"
                                    @click="openEditDialog(preference)"
                                >
                                    <AppIcon name="edit" class="h-4 w-4" />
                                </Button>
                                <Button
                                    variant="ghost-neutral"
                                    :title="t('common.delete')"
                                    :aria-label="t('common.delete')"
                                    @click="removePreference(preference)"
                                >
                                    <AppIcon name="trash" class="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>
            </template>
        </div>

        <ModelPreferenceDialog
            v-if="dialogOpen && editingPreference"
            :preference="editingPreference"
            :models="models"
            :saving="savingPreference"
            @save="savePreference"
            @cancel="closeDialog"
        />
    </div>
</template>
