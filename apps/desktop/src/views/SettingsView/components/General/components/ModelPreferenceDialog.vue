<script setup lang="ts">
    import DialogShell from '@components/DialogShell.vue';
    import ModelCapabilityTags from '@components/ModelCapabilityTags.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import SearchableSelect from '@components/SearchableSelect.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { ModelWithProvider } from '@database/queries/models';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';

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

    interface Props {
        preference: PreferenceForm;
        models: ModelWithProvider[];
        saving?: boolean;
    }

    interface Emits {
        (e: 'save', data: PreferenceForm): void;
        (e: 'cancel'): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        saving: false,
    });
    const emit = defineEmits<Emits>();
    const alert = useAlert();

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

    const form = ref<PreferenceForm>({ ...props.preference });
    const selectedProviderId = ref<number | null>(null);

    const enabledModels = computed(() =>
        [...props.models]
            .filter((model) => model.provider_enabled === 1)
            .sort(
                (left, right) =>
                    left.provider_name.localeCompare(right.provider_name) ||
                    left.name.localeCompare(right.name) ||
                    left.model_id.localeCompare(right.model_id)
            )
    );

    const selectedModel = computed(() => {
        const modelId = Number(form.value.modelId);
        return Number.isFinite(modelId)
            ? enabledModels.value.find((model) => model.id === modelId)
            : undefined;
    });

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

    const modelOptions = computed<ModelPreferenceSelectOption[]>(() => {
        if (selectedProviderId.value === null) {
            return [];
        }

        return enabledModels.value
            .filter((model) => model.provider_id === selectedProviderId.value)
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
    });

    function resolveProviderLogoPath(logo?: string): string {
        return (logo && providerLogos[logo]) || '';
    }

    function getProviderFallbackText(option: ModelPreferenceSelectOption | null): string {
        return option?.label?.charAt(0) || '?';
    }

    function initializeProvider() {
        const providerId = selectedModel.value?.provider_id ?? null;
        const firstProviderId = Number(providerOptions.value[0]?.value);
        selectedProviderId.value =
            providerId ?? (Number.isInteger(firstProviderId) ? firstProviderId : null);
    }

    watch(
        () => props.preference,
        (preference) => {
            form.value = { ...preference };
            initializeProvider();
        }
    );

    watch(
        () => props.models,
        () => {
            initializeProvider();
        },
        { immediate: true }
    );

    function updateProvider(value: string | number) {
        const providerId = Number(value);
        if (!Number.isInteger(providerId)) {
            return;
        }

        selectedProviderId.value = providerId;
        const firstModel = enabledModels.value.find((model) => model.provider_id === providerId);
        form.value.modelId = firstModel ? String(firstModel.id) : '';
    }

    function updateModel(value: string | number) {
        form.value.modelId = String(value);
    }

    function handleSave() {
        const nextForm = {
            ...form.value,
            name: form.value.name.trim(),
            description: form.value.description.trim(),
        };

        if (!nextForm.name) {
            alert.error(t('settings.general.modelPreferences.nameRequired'));
            return;
        }
        if (!nextForm.description) {
            alert.error(t('settings.general.modelPreferences.descriptionRequired'));
            return;
        }
        if (!nextForm.modelId) {
            alert.error(t('settings.general.modelPreferences.modelRequired'));
            return;
        }

        emit('save', nextForm);
    }
</script>

<template>
    <DialogShell>
        <h2 class="mb-5 text-base font-bold text-neutral-950">
            {{
                preference.id === null
                    ? t('settings.general.modelPreferences.addPreferenceTitle')
                    : t('settings.general.modelPreferences.editPreferenceTitle')
            }}
        </h2>

        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.general.modelPreferences.scenario') }}
                </label>
                <Input
                    v-model="form.name"
                    class="mt-1.5"
                    :placeholder="t('settings.general.modelPreferences.scenarioPlaceholder')"
                />
            </div>

            <div class="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)]">
                <div class="min-w-0">
                    <label class="block text-sm font-medium text-neutral-700">
                        {{ t('settings.builtInTools.upgradeModel.provider') }}
                    </label>
                    <SearchableSelect
                        :model-value="selectedProviderId"
                        :options="providerOptions"
                        class="mt-1.5"
                        placeholder-key="settings.builtInTools.upgradeModel.provider"
                        search-placeholder-key="settings.builtInTools.upgradeModel.searchProvider"
                        empty-text-key="settings.builtInTools.upgradeModel.emptyProviders"
                        protect-option-text
                        @update:model-value="updateProvider"
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
                </div>

                <div class="min-w-0">
                    <label class="block text-sm font-medium text-neutral-700">
                        {{ t('settings.general.modelPreferences.model') }}
                    </label>
                    <SearchableSelect
                        :model-value="form.modelId"
                        :options="modelOptions"
                        class="mt-1.5"
                        placeholder-key="settings.builtInTools.upgradeModel.model"
                        search-placeholder-key="settings.builtInTools.upgradeModel.searchModel"
                        empty-text-key="settings.builtInTools.upgradeModel.emptyModels"
                        protect-option-text
                        @update:model-value="updateModel"
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

            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('common.description') }}
                </label>
                <textarea
                    v-model="form.description"
                    rows="3"
                    class="focus:border-primary-400 mt-1.5 min-h-24 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 shadow-none transition-colors focus:outline-none"
                    :placeholder="t('settings.general.modelPreferences.descriptionPlaceholder')"
                />
            </div>
        </div>

        <div class="mt-6 flex gap-3">
            <Button
                class="bg-primary-700 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
                :disabled="saving"
                @click="handleSave"
            >
                {{ preference.id === null ? t('common.create') : t('common.save') }}
            </Button>
            <Button
                variant="outline"
                class="flex-1 rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:border-neutral-300"
                :disabled="saving"
                @click="emit('cancel')"
            >
                {{ t('common.cancel') }}
            </Button>
        </div>
    </DialogShell>
</template>
