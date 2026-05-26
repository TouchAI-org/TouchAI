<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import PasswordInput from '@components/PasswordInput.vue';
    import type { Provider } from '@database/schema';
    import { computed, ref, watch } from 'vue';

    import { aiService } from '@/services/AgentService';
    import { getProviderDriverDefinition } from '@/services/AgentService/infrastructure/providers';

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

    const driverDefinition = computed(() => getProviderDriverDefinition(props.provider.driver));
    const trimmedApiEndpoint = computed(() => form.value.api_endpoint.trim());

    const apiTargets = computed(() =>
        aiService
            .createProviderInstance(
                props.provider.driver,
                trimmedApiEndpoint.value,
                form.value.api_key || undefined,
                props.provider.config_json
            )
            .getApiTargets()
    );

    /**
     * 目标 API 只做运行时预览，不参与存储。
     * 这里仅展示最终的生成接口，避免把设置区做成多组“伪可编辑”地址。
     */
    const generationApiPreview = computed(() => apiTargets.value.generationTarget);

    const shouldShowGenerationApiPreview = computed(
        () => trimmedApiEndpoint.value.length > 0 && generationApiPreview.value.length > 0
    );

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    watch(
        () => props.provider,
        (newProvider, oldProvider) => {
            if (!oldProvider || newProvider.id !== oldProvider.id) {
                form.value = {
                    api_endpoint: newProvider.api_endpoint,
                    api_key: newProvider.api_key || '',
                };
            }
        }
    );

    /**
     * 这里保留局部表单态并做防抖，
     * 否则用户输入 base URL 时会和父层的数据库回写互相抖动。
     */
    const handleInput = () => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            if (!trimmedApiEndpoint.value) {
                return;
            }

            emit('update', {
                api_endpoint: trimmedApiEndpoint.value,
                api_key: form.value.api_key || null,
            });
        }, 800);
    };
</script>

<template>
    <div class="space-y-4">
        <h2 class="text-[15px] font-medium text-neutral-950">服务商配置</h2>

        <div class="settings-row-group divide-y divide-neutral-200/70">
            <div class="px-5 py-4">
                <label class="block text-sm font-normal text-neutral-700">请求地址 *</label>
                <input
                    v-model="form.api_endpoint"
                    type="text"
                    class="settings-input mt-1.5 w-full"
                    :placeholder="driverDefinition.placeholder"
                    @input="handleInput"
                />
                <p
                    v-if="shouldShowGenerationApiPreview"
                    class="mt-2 text-xs break-all text-neutral-400"
                >
                    根地址预览：
                    <span class="font-mono text-neutral-500">
                        {{ generationApiPreview }}
                    </span>
                </p>
            </div>

            <div class="px-5 py-4">
                <label class="block text-sm font-normal text-neutral-700">API Key</label>
                <PasswordInput v-model="form.api_key" placeholder="sk-..." @input="handleInput" />
            </div>
        </div>
    </div>
</template>
