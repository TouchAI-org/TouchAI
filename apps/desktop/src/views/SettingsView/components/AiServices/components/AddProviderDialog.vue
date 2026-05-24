<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import DialogShell from '@components/DialogShell.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { NewProvider, ProviderDriver } from '@database/schema';
    import { computed, ref } from 'vue';

    import { aiService } from '@/services/AgentService';
    import {
        getProviderDriverDefinition,
        providerDriverDefinitions,
    } from '@/services/AgentService/infrastructure/providers';


    import { t } from '@/i18n';
    interface Emits {
        (e: 'create', data: NewProvider): void;
        (e: 'cancel'): void;
    }

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

    const form = ref<Partial<NewProvider>>({
        name: '',
        driver: 'openai' as ProviderDriver,
        api_endpoint: '',
        api_key: '',
        config_json: null,
        logo: getProviderDriverDefinition('openai').logo,
        enabled: 1,
        is_builtin: 0,
    });

    const selectedDriverDefinition = computed(() =>
        getProviderDriverDefinition((form.value.driver as ProviderDriver) || 'openai')
    );

    const trimmedProviderName = computed(() => form.value.name?.trim() || '');
    const trimmedApiEndpoint = computed(() => form.value.api_endpoint?.trim() || '');

    const driverOptions = providerDriverDefinitions.map((definition) => ({
        label: definition.label,
        value: definition.driver,
        iconSrc: providerLogos[definition.logo] || '',
    }));

    const apiTargets = computed(() =>
        aiService
            .createProviderInstance(
                (form.value.driver as ProviderDriver) || 'openai',
                trimmedApiEndpoint.value,
                form.value.api_key || undefined,
                form.value.config_json || null
            )
            .getApiTargets()
    );

    const generationApiPreview = computed(() => apiTargets.value.generationTarget);

    const shouldShowGenerationApiPreview = computed(
        () => trimmedApiEndpoint.value.length > 0 && generationApiPreview.value.length > 0
    );

    const handleDriverChange = () => {
        form.value.logo = selectedDriverDefinition.value.logo;
    };

    const handleSave = () => {
        if (!trimmedProviderName.value || !trimmedApiEndpoint.value) {
            alert.error(t('settings.ai.enterProviderNameAndEndpoint'));
            return;
        }

        emit('create', {
            name: trimmedProviderName.value,
            driver: form.value.driver as ProviderDriver,
            api_endpoint: trimmedApiEndpoint.value,
            api_key: form.value.api_key || null,
            config_json: null,
            logo: form.value.logo!,
            enabled: form.value.enabled!,
            is_builtin: 0,
        });
    };
</script>

<template>
    <DialogShell>
        <h2 class="mb-5 text-base font-bold text-neutral-950">{{ t('settings.ai.addProvider.title') }}</h2>

        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-neutral-700">{{ t('settings.ai.providerNameRequired') }}</label>
                <Input v-model="form.name" class="mt-1.5" :placeholder="t('settings.ai.providerNamePlaceholder')" />
            </div>

            <div>
                <label class="block text-sm font-medium text-neutral-700">{{ t('settings.ai.providerTypeRequired') }}</label>
                <CustomSelect
                    v-model="form.driver!"
                    :options="driverOptions"
                    class="mt-1.5"
                    @update:model-value="handleDriverChange"
                />
            </div>

            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.apiEndpointRequired') }}
                </label>
                <Input
                    v-model="form.api_endpoint"
                    class="mt-1.5"
                    :placeholder="selectedDriverDefinition.placeholder"
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

            <div>
                <label class="block text-sm font-medium text-neutral-700">API Key</label>
                <PasswordInput v-model="form.api_key!" placeholder="sk-..." />
            </div>

            <div class="flex items-center">
                <input
                    id="enabled"
                    v-model="form.enabled"
                    type="checkbox"
                    :true-value="1"
                    :false-value="0"
                    class="h-4 w-4 rounded border-neutral-300 text-neutral-950"
                />
                <label for="enabled" class="ml-2 text-sm text-neutral-600">{{ t('settings.ai.enableAfterCreate') }}</label>
            </div>
        </div>

        <div class="mt-6 flex gap-3">
            <Button
                class="bg-primary-700 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
                @click="handleSave"
            >
                {{ t('common.create') }}
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
