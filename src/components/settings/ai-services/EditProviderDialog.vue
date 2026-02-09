<!-- Copyright (c) 2025. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/common/CustomSelect.vue';
    import { useAlert } from '@composables/useAlert';
    import type { Provider, ProviderType } from '@database/schema';
    import { ref, watch } from 'vue';

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

    const form = ref({
        name: props.provider.name,
        type: props.provider.type,
        logo: props.provider.logo,
    });

    watch(
        () => props.provider,
        (newProvider) => {
            form.value = {
                name: newProvider.name,
                type: newProvider.type,
                logo: newProvider.logo,
            };
        }
    );

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
        if (!form.value.name) {
            alert.error('请填写服务商名称');
            return;
        }

        emit('update', {
            name: form.value.name,
            type: form.value.type as ProviderType,
            logo: form.value.logo,
        });
    };
</script>

<template>
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div class="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <h2 class="mb-5 font-serif text-base font-semibold text-gray-900">编辑服务商</h2>

            <div class="space-y-4">
                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        服务商名称 *
                    </label>
                    <input
                        v-model="form.name"
                        type="text"
                        class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-serif text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="My Custom OpenAI"
                    />
                </div>

                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        服务商类型 *
                    </label>
                    <CustomSelect
                        v-model="form.type"
                        :options="providerTypeOptions"
                        class="mt-1.5"
                        @update:model-value="handleTypeChange"
                    />
                    <p class="mt-1 text-xs text-gray-400">选择 API 兼容类型，Logo 将自动设置</p>
                </div>
            </div>

            <div class="mt-6 flex gap-3">
                <button
                    class="bg-primary-500 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors"
                    @click="handleSave"
                >
                    保存
                </button>
                <button
                    class="flex-1 rounded-lg border border-gray-200 px-4 py-2 font-serif text-sm font-medium text-gray-600 transition-colors hover:border-gray-300"
                    @click="emit('cancel')"
                >
                    取消
                </button>
            </div>
        </div>
    </div>
</template>
