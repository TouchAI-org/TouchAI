<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import type { Provider } from '@database/schema';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { aiService } from '@/services/AgentService';
    import {
        getProviderDriverDefinition,
        isTouchAiManagedMode,
        parseProviderConfigJson,
    } from '@/services/AgentService/infrastructure/providers';
    import type { ProviderConfigJson } from '@/services/AgentService/infrastructure/providers/types';
    import { getManagedAuthState, logoutManagedAuth, openManagedLogin } from '@/services/AuthService';

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
    const touchAiCustomForm = ref({
        api_endpoint: '',
        api_key: '',
    });
    const managedAuthState = ref({
        isLoggedIn: false,
        login: null as string | null,
        avatarUrl: null as string | null,
    });
    const managedConfigMode = ref<'managed' | 'custom'>('managed');
    const managedAvatarLoadFailed = ref(false);

    const driverDefinition = computed(() => getProviderDriverDefinition(props.provider.driver));
    const isManagedTouchAiActivityProvider = computed(
        () => props.provider.driver === 'mimo' && props.provider.is_builtin === 1
    );
    const isManagedMode = computed(
        () => isManagedTouchAiActivityProvider.value && managedConfigMode.value === 'managed'
    );
    const touchAiProviderConfig = computed(() => parseProviderConfigJson(props.provider.config_json));
    const activeApiEndpoint = computed(() =>
        isManagedTouchAiActivityProvider.value && managedConfigMode.value === 'custom'
            ? touchAiCustomForm.value.api_endpoint.trim()
            : form.value.api_endpoint.trim()
    );
    const activeApiKey = computed(() =>
        isManagedTouchAiActivityProvider.value && managedConfigMode.value === 'custom'
            ? touchAiCustomForm.value.api_key.trim()
            : form.value.api_key.trim()
    );
    const providerConfigPreviewJson = computed(() => {
        if (!isManagedTouchAiActivityProvider.value) {
            return props.provider.config_json;
        }

        return stringifyProviderConfigJson({
            ...touchAiProviderConfig.value,
            touchAiMode: managedConfigMode.value,
            touchAiCustom: buildTouchAiCustomConfigPayload(),
        });
    });

    const apiTargets = computed(() =>
        aiService
            .createProviderInstance(
                props.provider.driver,
                activeApiEndpoint.value,
                activeApiKey.value || undefined,
                providerConfigPreviewJson.value
            )
            .getApiTargets()
    );

    /**
     * 目标 API 只做运行时预览，不参与存储。
     * 这里仅展示最终的生成接口，避免把设置区做成多组“伪可编辑”地址。
     */
    const generationApiPreview = computed(() => apiTargets.value.generationTarget);

    const shouldShowGenerationApiPreview = computed(
        () => activeApiEndpoint.value.length > 0 && generationApiPreview.value.length > 0
    );
    const shouldShowManagedAvatarImage = computed(
        () =>
            managedAuthState.value.isLoggedIn &&
            Boolean(managedAuthState.value.avatarUrl) &&
            !managedAvatarLoadFailed.value
    );
    const managedAvatarSrc = computed(() => managedAuthState.value.avatarUrl ?? undefined);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    function buildTouchAiCustomConfigPayload(): ProviderConfigJson['touchAiCustom'] | undefined {
        const apiEndpoint = touchAiCustomForm.value.api_endpoint.trim();
        const apiKey = touchAiCustomForm.value.api_key.trim();

        if (!apiEndpoint && !apiKey) {
            return undefined;
        }

        return {
            ...(apiEndpoint ? { apiEndpoint } : {}),
            ...(apiKey ? { apiKey } : {}),
        };
    }

    function stringifyProviderConfigJson(config: ProviderConfigJson): string | null {
        const nextConfig: ProviderConfigJson = {
            ...(config.headers ? { headers: config.headers } : {}),
            ...(config.queryParams ? { queryParams: config.queryParams } : {}),
            ...(config.managedAuth ? { managedAuth: config.managedAuth } : {}),
            ...(config.touchAiMode ? { touchAiMode: config.touchAiMode } : {}),
            ...(config.touchAiCustom ? { touchAiCustom: config.touchAiCustom } : {}),
        };

        return Object.keys(nextConfig).length > 0 ? JSON.stringify(nextConfig) : null;
    }

    function emitTouchAiModeUpdate(mode: 'managed' | 'custom') {
        emit('update', {
            config_json: stringifyProviderConfigJson({
                ...touchAiProviderConfig.value,
                touchAiMode: mode,
                touchAiCustom: buildTouchAiCustomConfigPayload(),
            }),
        });
    }

    function syncFormStateFromProvider(provider: Provider) {
        const parsedConfig = parseProviderConfigJson(provider.config_json);
        form.value = {
            api_endpoint: provider.api_endpoint,
            api_key: provider.api_key || '',
        };
        touchAiCustomForm.value = {
            api_endpoint: parsedConfig.touchAiCustom?.apiEndpoint || '',
            api_key: parsedConfig.touchAiCustom?.apiKey || '',
        };
        managedConfigMode.value = isTouchAiManagedMode(parsedConfig, provider.api_endpoint)
            ? 'managed'
            : 'custom';
    }

    watch(
        () => props.provider,
        async (newProvider, oldProvider) => {
            if (
                !oldProvider ||
                newProvider.id !== oldProvider.id ||
                newProvider.api_endpoint !== oldProvider.api_endpoint ||
                newProvider.api_key !== oldProvider.api_key ||
                newProvider.config_json !== oldProvider.config_json
            ) {
                syncFormStateFromProvider(newProvider);
            }
            if (newProvider.driver === 'mimo' && newProvider.is_builtin === 1) {
                const state = await getManagedAuthState();
                managedAuthState.value = {
                    isLoggedIn: state.isLoggedIn,
                    login: state.login,
                    avatarUrl: state.avatarUrl,
                };
            }
        },
        { immediate: true }
    );

    watch(
        () => [managedAuthState.value.avatarUrl, managedAuthState.value.isLoggedIn],
        () => {
            managedAvatarLoadFailed.value = false;
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
            if (isManagedTouchAiActivityProvider.value) {
                emit('update', {
                    config_json: stringifyProviderConfigJson({
                        ...touchAiProviderConfig.value,
                        touchAiMode: managedConfigMode.value,
                        touchAiCustom: buildTouchAiCustomConfigPayload(),
                    }),
                });
                return;
            }

            if (!activeApiEndpoint.value) {
                return;
            }

            emit('update', {
                api_endpoint: activeApiEndpoint.value,
                api_key: form.value.api_key || null,
            });
        }, 800);
    };

    const handleOpenActivityPage = async () => {
        await openManagedLogin();
    };

    const handleCancelManagedAuthorization = async () => {
        await logoutManagedAuth();
        managedAuthState.value = {
            ...managedAuthState.value,
            isLoggedIn: false,
            login: null,
            avatarUrl: null,
        };
    };

    const setManagedConfigMode = (mode: 'managed' | 'custom') => {
        managedConfigMode.value = mode;
        emitTouchAiModeUpdate(mode);
    };

    const handleManagedAvatarError = () => {
        managedAvatarLoadFailed.value = true;
    };
</script>

<template>
    <div class="space-y-4">
        <div class="flex items-center justify-between gap-4">
            <h2 class="text-[15px] font-medium text-neutral-950">
                {{ t('settings.ai.providerConfigTitle') }}
            </h2>
            <div
                v-if="isManagedTouchAiActivityProvider"
                class="inline-flex rounded-[10px] border border-neutral-200/80 bg-white p-1 shadow-none"
            >
                <button
                    type="button"
                    data-testid="settings-ai-services-mode-managed"
                    class="rounded-[8px] px-3 py-1.5 text-[12px] font-medium transition-colors"
                    :class="
                        managedConfigMode === 'managed'
                            ? 'bg-[#e9e9e7] text-neutral-950'
                            : 'text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800'
                    "
                    @click="setManagedConfigMode('managed')"
                >
                    {{ t('settings.ai.mode.managed') }}
                </button>
                <button
                    type="button"
                    data-testid="settings-ai-services-mode-custom"
                    class="rounded-[8px] px-3 py-1.5 text-[12px] font-medium transition-colors"
                    :class="
                        managedConfigMode === 'custom'
                            ? 'bg-[#e9e9e7] text-neutral-950'
                            : 'text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800'
                    "
                    @click="setManagedConfigMode('custom')"
                >
                    {{ t('settings.ai.mode.custom') }}
                </button>
            </div>
        </div>

        <div
            v-if="isManagedMode"
            data-testid="settings-managed-activity-provider"
            class="settings-row-group"
        >
            <div class="flex items-center justify-between gap-4 px-5 py-4">
                <div
                    data-testid="settings-managed-activity-status"
                    class="flex min-w-0 items-center gap-3"
                >
                    <template v-if="managedAuthState.isLoggedIn">
                        <img
                            v-if="shouldShowManagedAvatarImage"
                            :src="managedAvatarSrc"
                            :alt="managedAuthState.login || 'TouchAI Hub'"
                            class="h-9 w-9 rounded-full object-cover ring-1 ring-neutral-200"
                            @error="handleManagedAvatarError"
                        />
                        <div
                            v-else
                            data-testid="settings-managed-activity-github-avatar"
                            class="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200"
                        >
                            <AppIcon name="github" class="h-4.5 w-4.5" />
                        </div>
                        <span class="min-w-0 truncate text-sm font-medium text-neutral-900">
                            {{ managedAuthState.login || 'GitHub' }}
                        </span>
                    </template>
                    <span v-else class="text-sm text-neutral-600">
                        {{ t('settings.ai.managedActivity.loggedOut') }}
                    </span>
                </div>

                <div class="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        data-testid="settings-managed-activity-page-button"
                        class="settings-button-secondary cursor-pointer"
                        @click="handleOpenActivityPage"
                    >
                        {{
                            managedAuthState.isLoggedIn
                                ? t('settings.ai.managedActivity.reloginAction')
                                : t('settings.ai.managedActivity.openActivityPage')
                        }}
                    </button>

                    <button
                        v-if="managedAuthState.isLoggedIn"
                        type="button"
                        data-testid="settings-managed-activity-cancel-button"
                        class="settings-button-secondary cursor-pointer text-red-600 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                        @click="handleCancelManagedAuthorization"
                    >
                        {{ t('settings.ai.managedActivity.logoutAction') }}
                    </button>
                </div>
            </div>
        </div>

        <div
            v-else-if="isManagedTouchAiActivityProvider"
            class="settings-row-group divide-y divide-neutral-200/70"
        >
            <div class="px-5 py-4">
                <label class="block text-sm font-normal text-neutral-700">
                    {{ t('settings.ai.apiEndpointRequired') }}
                </label>
                <input
                    v-model="touchAiCustomForm.api_endpoint"
                    type="text"
                    class="settings-input mt-1.5 w-full"
                    :placeholder="getProviderDriverDefinition('mimo').placeholder"
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

            <div class="px-5 py-4">
                <label class="block text-sm font-normal text-neutral-700">API Key</label>
                <PasswordInput
                    v-model="touchAiCustomForm.api_key"
                    placeholder="sk-..."
                    @input="handleInput"
                />
            </div>
        </div>

        <div v-else class="settings-row-group divide-y divide-neutral-200/70">
            <div class="px-5 py-4">
                <label class="block text-sm font-normal text-neutral-700">
                    {{ t('settings.ai.apiEndpointRequired') }}
                </label>
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
                    {{ t('settings.ai.providerBaseUrlPreview') }}
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
