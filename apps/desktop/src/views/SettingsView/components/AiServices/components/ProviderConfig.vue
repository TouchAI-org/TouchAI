<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import PasswordInput from '@components/PasswordInput.vue';
    import { Input } from '@components/ui/input';
    import type { Provider } from '@database/schema';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { getProviderDriverDefinition } from '@/services/AgentService/infrastructure/providers/driverCatalog';
    import type { ProviderApiTargets } from '@/services/AgentService/infrastructure/providers/types';

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

    // API 预览需要实例化 adapter，但不应让设置页在打开时就拉入全部 provider SDK；
    // 这里按需动态加载，并用 requestId 丢弃过期结果。
    const apiTargets = ref<ProviderApiTargets | null>(null);
    let apiPreviewRequestId = 0;

    watch(
        [() => props.provider.id, () => props.provider.driver, trimmedApiEndpoint, () => form.value.api_key],
        async () => {
            const requestId = ++apiPreviewRequestId;
            const endpoint = trimmedApiEndpoint.value;
            if (!endpoint) {
                apiTargets.value = null;
                return;
            }

            try {
                const { aiService } = await import('@/services/AgentService');
                if (requestId !== apiPreviewRequestId) return;
                apiTargets.value = aiService
                    .createProviderInstance(
                        props.provider.driver,
                        endpoint,
                        form.value.api_key || undefined,
                        props.provider.config_json
                    )
                    .getApiTargets();
            } catch {
                if (requestId === apiPreviewRequestId) {
                    apiTargets.value = null;
                }
            }
        },
        { immediate: true }
    );

    const generationApiPreview = computed(() => apiTargets.value?.generationTarget ?? '');

    const shouldShowGenerationApiPreview = computed(
        () => trimmedApiEndpoint.value.length > 0 && generationApiPreview.value.length > 0
    );

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    watch(
        () => props.provider,
        (newProvider, oldProvider) => {
            if (
                !oldProvider ||
                newProvider.id !== oldProvider.id ||
                newProvider.api_endpoint !== oldProvider.api_endpoint ||
                newProvider.api_key !== oldProvider.api_key
            ) {
                form.value = {
                    api_endpoint: newProvider.api_endpoint,
                    api_key: newProvider.api_key || '',
                };
            }
        }
    );

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
        <h2 class="text-reading font-medium text-neutral-950">
            {{ t('settings.ai.providerConfigTitle') }}
        </h2>

        <div class="settings-row-group divide-y divide-neutral-200/70">
            <div class="px-5 py-4" data-settings-search-target="provider-endpoint">
                <label class="block text-sm font-normal text-neutral-700">
                    {{ t('settings.ai.apiEndpointRequired') }}
                </label>
                <Input
                    v-model="form.api_endpoint"
                    variant="filled"
                    type="text"
                    class="mt-1.5 w-full"
                    :placeholder="driverDefinition.placeholder"
                    @input="handleInput"
                />
                <p
                    v-if="shouldShowGenerationApiPreview"
                    class="mt-2 text-xs break-all text-neutral-400"
                >
                    {{ t('settings.ai.providerBaseUrlPreview') }}
                    <span class="font-mono text-neutral-500">
                        {{ generationApiPreview }}
                    </span>
                </p>
            </div>

            <div class="px-5 py-4" data-settings-search-target="provider-api-key">
                <label class="block text-sm font-normal text-neutral-700">API Key</label>
                <PasswordInput v-model="form.api_key" placeholder="sk-..." @input="handleInput" />
            </div>
        </div>
    </div>
</template>
