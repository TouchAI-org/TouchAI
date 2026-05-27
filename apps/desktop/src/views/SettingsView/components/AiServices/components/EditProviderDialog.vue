<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import DialogShell from '@components/DialogShell.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { Provider, ProviderDriver } from '@database/schema';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { aiService } from '@/services/AgentService';
    import {
        getProviderDriverDefinition,
        providerDriverDefinitions,
    } from '@/services/AgentService/infrastructure/providers';
    interface Props {
        provider: Provider;
    }

    interface Emits {
        (e: 'update', data: Partial<Provider>): void;
        (e: 'cancel'): void;
    }

    const props = defineProps<Props>();
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

    const form = ref({
        name: props.provider.name,
        driver: props.provider.driver,
        logo: props.provider.logo,
    });

    watch(
        () => props.provider,
        (newProvider) => {
            form.value = {
                name: newProvider.name,
                driver: newProvider.driver,
                logo: newProvider.logo,
            };
        }
    );

    const selectedDriverDefinition = computed(() =>
        getProviderDriverDefinition((form.value.driver as ProviderDriver) || 'openai')
    );
    const trimmedProviderName = computed(() => form.value.name.trim());

    const driverOptions = providerDriverDefinitions.map((definition) => ({
        label: definition.label,
        value: definition.driver,
        iconSrc: providerLogos[definition.logo] || '',
    }));

    const apiTargets = computed(() =>
        aiService
            .createProviderInstance(
                (form.value.driver as ProviderDriver) || 'openai',
                props.provider.api_endpoint,
                props.provider.api_key || undefined,
                props.provider.config_json
            )
            .getApiTargets()
    );

    const generationApiPreview = computed(() => apiTargets.value.generationTarget);

    const shouldShowGenerationApiPreview = computed(
        () => props.provider.api_endpoint.trim().length > 0 && generationApiPreview.value.length > 0
    );

    const handleDriverChange = () => {
        form.value.logo = selectedDriverDefinition.value.logo;
    };

    const handleSave = () => {
        if (!trimmedProviderName.value) {
            alert.error(t('settings.ai.enterProviderName'));
            return;
        }

        emit('update', {
            name: trimmedProviderName.value,
            driver: form.value.driver as ProviderDriver,
            logo: form.value.logo,
        });
    };
</script>

<template>
    <DialogShell>
        <h2 class="mb-5 text-[15px] font-medium text-neutral-950">
            {{ t('settings.ai.editProvider.title') }}
        </h2>

        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.providerNameRequired') }}
                </label>
                <Input
                    v-model="form.name"
                    class="mt-1.5"
                    :placeholder="t('settings.ai.providerNamePlaceholder')"
                />
            </div>

            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.providerTypeRequired') }}
                </label>
                <CustomSelect
                    v-model="form.driver"
                    :options="driverOptions"
                    class="mt-1.5"
                    @update:model-value="handleDriverChange"
                />
                <p
                    v-if="shouldShowGenerationApiPreview"
                    class="mt-1 text-xs break-all text-neutral-400"
                >
                    {{ t('settings.ai.providerBaseUrlPreview') }}
                    <span class="font-mono">
                        {{ generationApiPreview }}
                    </span>
                </p>
            </div>
        </div>

        <div class="mt-6 flex gap-3">
            <Button
                class="bg-primary-700 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
                @click="handleSave"
            >
                {{ t('common.save') }}
            </Button>
            <Button
                variant="outline"
                class="flex-1 rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:border-neutral-300"
                @click="emit('cancel')"
            >
                {{ t('common.cancel') }}
            </Button>
        </div>
    </DialogShell>
</template>
