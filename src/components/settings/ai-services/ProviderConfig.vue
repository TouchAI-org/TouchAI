<!-- Copyright (c) 2025. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import PasswordInput from '@components/common/PasswordInput.vue';
    import type { Provider } from '@database/schema';
    import { ref, watch } from 'vue';

    interface Props {
        provider: Provider;
    }

    interface Emits {
        (e: 'update', data: Partial<Provider>): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const form = ref({
        api_endpoint: props.provider.api_endpoint,
        api_key: props.provider.api_key || '',
    });

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    watch(
        () => props.provider,
        (newProvider, oldProvider) => {
            // 只有在切换到不同的服务商时才重置表单
            if (!oldProvider || newProvider.id !== oldProvider.id) {
                form.value = {
                    api_endpoint: newProvider.api_endpoint,
                    api_key: newProvider.api_key || '',
                };
            }
        }
    );

    // 防抖自动保存
    const handleInput = () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            emit('update', {
                api_endpoint: form.value.api_endpoint,
                api_key: form.value.api_key || null,
            });
        }, 800); // 800ms 防抖延迟
    };
</script>

<template>
    <div class="space-y-4">
        <h3 class="font-serif text-sm font-semibold text-gray-900">服务商配置</h3>

        <div class="rounded-lg border border-gray-200 bg-white p-5">
            <div class="space-y-4">
                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        API 地址 *
                    </label>
                    <input
                        v-model="form.api_endpoint"
                        type="text"
                        class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-serif text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="https://api.openai.com"
                        @input="handleInput"
                    />
                    <p v-if="form.api_endpoint" class="mt-1 text-xs text-gray-400">
                        预览：{{ form.api_endpoint
                        }}{{
                            provider.type === 'openai'
                                ? '/v1/chat/completions'
                                : provider.type === 'anthropic'
                                  ? '/v1/messages'
                                  : ''
                        }}
                    </p>
                </div>

                <div>
                    <label class="block font-serif text-sm font-medium text-gray-600">
                        API Key
                    </label>
                    <PasswordInput
                        v-model="form.api_key"
                        placeholder="sk-..."
                        @input="handleInput"
                    />
                </div>
            </div>
        </div>
    </div>
</template>
