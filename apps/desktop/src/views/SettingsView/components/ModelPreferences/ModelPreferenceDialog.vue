<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import DialogShell from '@components/DialogShell.vue';
    import SearchableSelect from '@components/SearchableSelect.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { ModelWithProvider } from '@database/queries/models';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';

    export interface ModelPreferenceForm {
        id: string | null;
        name: string;
        description: string;
        modelId: string;
    }

    interface ModelOption {
        value: string;
        label: string;
        description: string;
        searchText: string;
    }

    interface Props {
        preference: ModelPreferenceForm;
        models: ModelWithProvider[];
        saving?: boolean;
    }

    interface Emits {
        (event: 'save', data: ModelPreferenceForm): void;
        (event: 'cancel'): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        saving: false,
    });
    const emit = defineEmits<Emits>();
    const alert = useAlert();

    const form = ref<ModelPreferenceForm>({ ...props.preference });

    watch(
        () => props.preference,
        (preference) => {
            form.value = { ...preference };
        }
    );

    const modelOptions = computed<ModelOption[]>(() =>
        props.models
            .filter((model) => model.provider_enabled === 1)
            .slice()
            .sort(
                (left, right) =>
                    left.provider_name.localeCompare(right.provider_name) ||
                    left.name.localeCompare(right.name) ||
                    left.model_id.localeCompare(right.model_id)
            )
            .map((model) => ({
                value: String(model.id),
                label: `${model.provider_name} / ${model.name}`,
                description: model.model_id,
                searchText: `${model.provider_name} ${model.name} ${model.model_id}`,
            }))
    );

    function submit() {
        const name = form.value.name.trim();
        const description = form.value.description.trim();

        if (!name) {
            alert.error(t('settings.modelRouting.nameRequired'));
            return;
        }
        if (!description) {
            alert.error(t('settings.modelRouting.descriptionRequired'));
            return;
        }
        if (!form.value.modelId) {
            alert.error(t('settings.modelRouting.modelRequired'));
            return;
        }

        emit('save', {
            ...form.value,
            name,
            description,
        });
    }
</script>

<template>
    <DialogShell>
        <h2 class="mb-5 text-base font-medium text-text-primary">
            {{
                form.id === null
                    ? t('settings.modelRouting.addPreferenceTitle')
                    : t('settings.modelRouting.editPreferenceTitle')
            }}
        </h2>

        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-text-secondary">
                    {{ t('settings.modelRouting.scenario') }}
                </label>
                <Input
                    v-model="form.name"
                    class="mt-1.5"
                    data-testid="model-preference-name"
                    :placeholder="t('settings.modelRouting.scenarioPlaceholder')"
                />
            </div>

            <div>
                <label class="block text-sm font-medium text-text-secondary">
                    {{ t('common.description') }}
                </label>
                <textarea
                    v-model="form.description"
                    rows="3"
                    data-testid="model-preference-description"
                    class="mt-1.5 min-h-24 w-full resize-y rounded-control border border-transparent bg-surface-sunken px-3 py-2 font-serif text-compact text-text-primary transition-colors placeholder:text-text-tertiary hover:bg-surface-active focus:border-ring focus:bg-surface-raised focus:outline-none"
                    :placeholder="t('settings.modelRouting.descriptionPlaceholder')"
                />
            </div>

            <div>
                <label class="block text-sm font-medium text-text-secondary">
                    {{ t('settings.modelRouting.selectModel') }}
                </label>
                <SearchableSelect
                    v-model="form.modelId"
                    class="mt-1.5"
                    data-testid="model-preference-model"
                    :options="modelOptions"
                    :placeholder-key="'settings.modelRouting.selectModel'"
                    :search-placeholder-key="'settings.modelRouting.selectModel'"
                    :empty-text-key="'settings.modelRouting.noModelsTitle'"
                    protect-option-text
                />
            </div>
        </div>

        <div class="mt-6 flex gap-3">
            <Button
                variant="strong"
                class="flex-1"
                data-testid="model-preference-save"
                :disabled="saving"
                @click="submit"
            >
                {{ form.id === null ? t('common.create') : t('common.save') }}
            </Button>
            <Button
                variant="outline-neutral"
                class="flex-1"
                data-testid="model-preference-cancel"
                :disabled="saving"
                @click="emit('cancel')"
            >
                {{ t('common.cancel') }}
            </Button>
        </div>
    </DialogShell>
</template>
