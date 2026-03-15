<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import DialogShell from '@components/DialogShell.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { NewProvider, ProviderType } from '@database/schema';
    import { ref } from 'vue';

    interface Emits {
        (e: 'create', data: NewProvider): void;
        (e: 'cancel'): void;
    }

    const emit = defineEmits<Emits>();

    const alert = useAlert();

    const form = ref<Partial<NewProvider>>({
        name: '',
        type: 'openai' as ProviderType,
        api_endpoint: '',
        api_key: '',
        logo: 'openai.png',
        enabled: 1,
        is_builtin: 0,
    });

    const handleTypeChange = () => {
        // 根据类型自动设置 logo
        form.value.logo = form.value.type === 'openai' ? 'openai.png' : 'claude.png';
    };

    const providerTypeOptions = [
        { label: 'OpenAI', value: 'openai' as ProviderType, description: 'OpenAI 兼容 API' },
        {
            label: 'Anthropic',
            value: 'anthropic' as ProviderType,
            description: 'Anthropic Claude API',
        },
    ];

    const handleSave = () => {
        if (!form.value.name || !form.value.api_endpoint) {
            alert.error('请填写服务商名称和 API 地址');
            return;
        }

        emit('create', {
            name: form.value.name,
            type: form.value.type as ProviderType,
            api_endpoint: form.value.api_endpoint,
            api_key: form.value.api_key || null,
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
                    v-model="form.type!"
                    :options="providerTypeOptions"
                    class="mt-1.5"
                    @update:model-value="handleTypeChange"
                />
                <p class="mt-1 text-xs text-gray-400">选择 API 兼容类型，Logo 将自动设置</p>
            </div>

            <div>
                <label class="block font-serif text-sm font-medium text-gray-600">API 地址 *</label>
                <Input
                    v-model="form.api_endpoint"
                    class="mt-1.5 font-serif"
                    placeholder="https://api.openai.com"
                />
                <p class="mt-1 text-xs text-gray-400">
                    API 地址，只需要域名勿加/v1后缀，如https://api.openai.com
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
