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
            alert.error('请填写服务商名称和 Base URL');
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
        <h2 class="mb-5 font-serif text-base font-bold text-gray-900">添加自定义服务商</h2>

        <div class="space-y-4">
            <div>
                <label class="block font-serif text-sm font-medium text-gray-600">
                    服务商名称 *
                </label>
                <Input
                    v-model="form.name"
                    class="mt-1.5 font-serif"
                    placeholder="我的自定义服务商"
                />
            </div>

            <div>
                <label class="block font-serif text-sm font-medium text-gray-600">
                    服务商类型 *
                </label>
                <CustomSelect
                    v-model="form.driver!"
                    :options="driverOptions"
                    class="mt-1.5"
                    @update:model-value="handleDriverChange"
                />
            </div>

            <div>
                <label class="block font-serif text-sm font-medium text-gray-600">Base URL *</label>
                <Input
                    v-model="form.api_endpoint"
                    class="mt-1.5 font-serif"
                    :placeholder="selectedDriverDefinition.placeholder"
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

            <div>
                <label class="block font-serif text-sm font-medium text-gray-600">API Key</label>
                <PasswordInput v-model="form.api_key!" placeholder="sk-..." />
            </div>

            <div class="flex items-center">
                <input
                    id="enabled"
                    v-model="form.enabled"
                    type="checkbox"
                    :true-value="1"
                    :false-value="0"
                    class="text-primary-500 h-4 w-4 rounded border-gray-300"
                />
                <label for="enabled" class="ml-2 text-sm text-gray-600">创建后立即启用</label>
            </div>
        </div>

        <div class="mt-6 flex gap-3">
            <Button
                class="bg-primary-500 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors"
                @click="handleSave"
            >
                创建
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
