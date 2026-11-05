<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import PasswordInput from '@components/PasswordInput.vue';
    import { Input } from '@components/ui/input';
    import type { Provider } from '@database/schema';
    import { computed, onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { aiService } from '@/services/AgentService';
    import { getProviderDriverDefinition } from '@/services/AgentService/infrastructure/providers';
    import {
        beginProviderConfigurationAttempt,
        mapProviderCategory,
        type ProviderConfigurationAttempt,
    } from '@/services/AnalyticsService/productInteractions';

    interface Props {
        provider: Provider;
    }

    interface Emits {
        (e: 'edit-start'): void;
        (
            e: 'update',
            data: Partial<Provider>,
            providerId: number,
            attempt: ProviderConfigurationAttempt
        ): void;
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

    const generationApiPreview = computed(() => apiTargets.value.generationTarget);

    const shouldShowGenerationApiPreview = computed(
        () => trimmedApiEndpoint.value.length > 0 && generationApiPreview.value.length > 0
    );

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingEdit: { providerId: number; attempt: ProviderConfigurationAttempt } | null = null;

    function cancelPendingEdit() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
        const edit = pendingEdit;
        pendingEdit = null;
        void edit?.attempt.abandon().catch(() => {});
    }

    onUnmounted(cancelPendingEdit);

    watch(
        () => props.provider,
        (newProvider, oldProvider) => {
            const providerChanged = newProvider.id !== oldProvider?.id;
            if (providerChanged) cancelPendingEdit();
            if (
                providerChanged ||
                (!pendingEdit &&
                    (newProvider.api_endpoint !== oldProvider?.api_endpoint ||
                        newProvider.api_key !== oldProvider?.api_key))
            ) {
                form.value = {
                    api_endpoint: newProvider.api_endpoint,
                    api_key: newProvider.api_key || '',
                };
            }
        },
        { flush: 'sync' }
    );

    const handleInput = () => {
        if (!pendingEdit) {
            pendingEdit = {
                providerId: props.provider.id,
                attempt: beginProviderConfigurationAttempt({
                    providerCategory: mapProviderCategory(props.provider.driver),
                    entry: 'settings',
                }),
            };
            emit('edit-start');
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        const edit = pendingEdit;
        const patch = {
            api_endpoint: trimmedApiEndpoint.value,
            api_key: form.value.api_key || null,
        };
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            pendingEdit = null;
            if (!patch.api_endpoint) {
                void edit.attempt.abandon().catch(() => {});
                return;
            }

            emit('update', patch, edit.providerId, edit.attempt);
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
