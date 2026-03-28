<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import DialogShell from '@components/DialogShell.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { Provider, ProviderDriver } from '@database/schema';
    import { aiService } from '@services/AiService';
    import {
        getProviderDriverDefinition,
        providerDriverDefinitions,
    } from '@services/AiService/provider';
    import { computed, ref, watch } from 'vue';

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
            alert.error('请填写服务商名称');
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
        <h2 class="mb-5 font-serif text-base font-semibold text-gray-900">编辑服务商</h2>

        <div class="space-y-4">
            <div>
                <label class="block font-serif text-sm font-medium text-gray-600">
                    服务商名称 *
                </label>
                <Input
                    v-model="form.name"
                    class="mt-1.5 font-serif"
                    placeholder="My Custom Provider"
                />
            </div>

            <div>
                <label class="block font-serif text-sm font-medium text-gray-600">
                    服务商类型 *
                </label>
                <CustomSelect
                    v-model="form.driver"
                    :options="driverOptions"
                    class="mt-1.5"
                    @update:model-value="handleDriverChange"
                />
                <p
                    v-if="shouldShowGenerationApiPreview"
                    class="mt-1 text-xs break-all text-gray-400"
                >
                    根地址预览：
                    <span class="font-mono">
                        {{ generationApiPreview }}
                    </span>
                </p>
            </div>
        </div>

        <div class="mt-6 flex gap-3">
            <Button
                class="bg-primary-500 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors"
                @click="handleSave"
            >
                保存
            </Button>
            <Button
                variant="outline"
                class="flex-1 rounded-lg border border-gray-200 px-4 py-2 font-serif text-sm font-medium text-gray-600 transition-colors hover:border-gray-300"
                @click="emit('cancel')"
            >
                取消
            </Button>
        </div>
    </DialogShell>
</template>
