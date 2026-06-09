<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import { findBuiltInToolByToolId, updateBuiltInTool } from '@database/queries';
    import { storeToRefs } from 'pinia';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import {
        parseSearchSettingsConfig,
        SEARCH_PROVIDER_API_KEY_REQUIREMENTS,
        SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS,
        SEARCH_PROVIDER_IDS,
        SEARCH_ROUTE_INTENTS,
        type SearchProviderId,
        type SearchRouteIntent,
        type SearchSettingsConfig,
        serializeSearchSettingsConfig,
    } from '@/stores/setting/sections/search';
    import { useSettingsStore } from '@/stores/settings';

    defineOptions({ name: 'SettingsSearchSection' });

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);
    const draft = ref<SearchSettingsConfig>(cloneConfig(settings.value.searchSettings));
    const toolRowId = ref<number | null>(null);
    const toolEnabled = ref(true);
    const savingToolEnabled = ref(false);
    const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const invalidProviderIds = ref<Set<SearchProviderId>>(new Set());
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let isSyncingFromStore = false;

    const providerMessages: Record<
        SearchProviderId,
        {
            label: MessageKey;
            description: MessageKey;
            keyPlaceholder: MessageKey;
            quotaLabel?: MessageKey;
        }
    > = {
        auto: {
            label: 'settings.search.provider.auto',
            description: 'settings.search.provider.auto.description',
            keyPlaceholder: 'settings.search.provider.auto.keyPlaceholder',
        },
        anysearch: {
            label: 'settings.search.provider.anysearch',
            description: 'settings.search.provider.anysearch.description',
            keyPlaceholder: 'settings.search.provider.anysearch.keyPlaceholder',
            quotaLabel: 'settings.search.provider.anysearch.quota',
        },
        wikipedia: {
            label: 'settings.search.provider.wikipedia',
            description: 'settings.search.provider.wikipedia.description',
            keyPlaceholder: 'settings.search.provider.wikipedia.keyPlaceholder',
            quotaLabel: 'settings.search.provider.wikipedia.quota',
        },
        openalex: {
            label: 'settings.search.provider.openalex',
            description: 'settings.search.provider.openalex.description',
            keyPlaceholder: 'settings.search.provider.openalex.keyPlaceholder',
            quotaLabel: 'settings.search.provider.openalex.quota',
        },
        semantic_scholar: {
            label: 'settings.search.provider.semanticScholar',
            description: 'settings.search.provider.semanticScholar.description',
            keyPlaceholder: 'settings.search.provider.semanticScholar.keyPlaceholder',
            quotaLabel: 'settings.search.provider.semanticScholar.quota',
        },
        github: {
            label: 'settings.search.provider.github',
            description: 'settings.search.provider.github.description',
            keyPlaceholder: 'settings.search.provider.github.keyPlaceholder',
            quotaLabel: 'settings.search.provider.github.quota',
        },
        brave: {
            label: 'settings.search.provider.brave',
            description: 'settings.search.provider.brave.description',
            keyPlaceholder: 'settings.search.provider.brave.keyPlaceholder',
            quotaLabel: 'settings.search.provider.brave.quota',
        },
        tavily: {
            label: 'settings.search.provider.tavily',
            description: 'settings.search.provider.tavily.description',
            keyPlaceholder: 'settings.search.provider.tavily.keyPlaceholder',
            quotaLabel: 'settings.search.provider.tavily.quota',
        },
        exa: {
            label: 'settings.search.provider.exa',
            description: 'settings.search.provider.exa.description',
            keyPlaceholder: 'settings.search.provider.exa.keyPlaceholder',
            quotaLabel: 'settings.search.provider.exa.quota',
        },
        firecrawl: {
            label: 'settings.search.provider.firecrawl',
            description: 'settings.search.provider.firecrawl.description',
            keyPlaceholder: 'settings.search.provider.firecrawl.keyPlaceholder',
            quotaLabel: 'settings.search.provider.firecrawl.quota',
        },
        searxng: {
            label: 'settings.search.provider.searxng',
            description: 'settings.search.provider.searxng.description',
            keyPlaceholder: 'settings.search.provider.searxng.keyPlaceholder',
            quotaLabel: 'settings.search.provider.searxng.quota',
        },
    };

    const intentMessages: Record<
        SearchRouteIntent,
        { label: MessageKey; description: MessageKey }
    > = {
        general: {
            label: 'settings.search.intent.general',
            description: 'settings.search.intent.general.description',
        },
        academic: {
            label: 'settings.search.intent.academic',
            description: 'settings.search.intent.academic.description',
        },
        technical: {
            label: 'settings.search.intent.technical',
            description: 'settings.search.intent.technical.description',
        },
        official: {
            label: 'settings.search.intent.official',
            description: 'settings.search.intent.official.description',
        },
        news: {
            label: 'settings.search.intent.news',
            description: 'settings.search.intent.news.description',
        },
    };

    const providerOptions = computed(() =>
        SEARCH_PROVIDER_IDS.filter(
            (providerId) => providerId === 'auto' || draft.value.providers[providerId].enabled
        ).map((providerId) => ({
            value: providerId,
            label: t(providerMessages[providerId].label),
        }))
    );

    const enabledProviderOptions = computed(() =>
        SEARCH_PROVIDER_IDS.filter(
            (providerId) => providerId === 'auto' || draft.value.providers[providerId].enabled
        ).map((providerId) => ({
            value: providerId,
            label: t(providerMessages[providerId].label),
        }))
    );

    const routeRows = computed(() =>
        SEARCH_ROUTE_INTENTS.map((intent) => ({
            intent,
            label: t(intentMessages[intent].label),
            description: t(intentMessages[intent].description),
        }))
    );

    const providerRows = computed(() =>
        SEARCH_PROVIDER_IDS.filter((providerId) => providerId !== 'auto')
            .map((providerId, index) => ({
                id: providerId,
                order: index,
                enabled: draft.value.providers[providerId].enabled,
                apiKeyRequired: providerRequiresApiKey(providerId),
                endpointRequired: providerRequiresEndpoint(providerId),
                label: t(providerMessages[providerId].label),
                description: t(providerMessages[providerId].description),
                keyPlaceholder: t(providerMessages[providerId].keyPlaceholder),
                quotaLabel: providerMessages[providerId].quotaLabel
                    ? t(providerMessages[providerId].quotaLabel)
                    : null,
            }))
            .sort((left, right) => {
                if (left.enabled !== right.enabled) {
                    return left.enabled ? -1 : 1;
                }
                return left.order - right.order;
            })
    );

    const advancedRows = computed<
        Array<{
            key: 'parallelProviders' | 'fallbackEnabled' | 'preferOfficialSources';
            label: string;
            description: string;
        }>
    >(() => [
        {
            key: 'parallelProviders',
            label: t('settings.search.parallelProviders'),
            description: t('settings.search.parallelProviders.description'),
        },
        {
            key: 'fallbackEnabled',
            label: t('settings.search.fallbackEnabled'),
            description: t('settings.search.fallbackEnabled.description'),
        },
        {
            key: 'preferOfficialSources',
            label: t('settings.search.preferOfficialSources'),
            description: t('settings.search.preferOfficialSources.description'),
        },
    ]);

    const canSave = computed(() => saveState.value !== 'saving');

    watch(
        () => settings.value.searchSettings,
        (config) => {
            isSyncingFromStore = true;
            draft.value = cloneConfig(config);
            queueMicrotask(() => {
                isSyncingFromStore = false;
            });
        },
        { deep: true }
    );

    watch(draft, scheduleAutoSave, { deep: true });

    onMounted(() => {
        void loadToolState();
    });

    onBeforeUnmount(() => {
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
    });

    function cloneConfig(config: SearchSettingsConfig): SearchSettingsConfig {
        return parseSearchSettingsConfig(serializeSearchSettingsConfig(config));
    }

    function scheduleAutoSave() {
        if (isSyncingFromStore || !canSave.value) return;
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
        }
        autoSaveTimer = setTimeout(() => {
            autoSaveTimer = null;
            void saveSettings();
        }, 250);
    }

    async function loadToolState() {
        try {
            const tool = await findBuiltInToolByToolId('web_search');
            toolRowId.value = tool?.id ?? null;
            toolEnabled.value = tool ? tool.enabled === 1 : true;
        } catch (error) {
            console.error('[SearchSettings] Failed to load web_search tool state:', error);
        }
    }

    async function toggleToolEnabled() {
        if (savingToolEnabled.value) return;
        const nextEnabled = !toolEnabled.value;
        if (toolRowId.value === null) {
            toolEnabled.value = nextEnabled;
            return;
        }

        savingToolEnabled.value = true;
        try {
            const updated = await updateBuiltInTool(toolRowId.value, {
                enabled: nextEnabled ? 1 : 0,
            });
            toolEnabled.value = updated ? updated.enabled === 1 : nextEnabled;
        } catch (error) {
            console.error('[SearchSettings] Failed to toggle web_search:', error);
        } finally {
            savingToolEnabled.value = false;
        }
    }

    async function saveSettings() {
        if (!canSave.value) return;
        saveState.value = 'saving';
        try {
            await settingsStore.updateSearchSettings({ ...draft.value });
            saveState.value = 'saved';
            isSyncingFromStore = true;
            queueMicrotask(() => {
                isSyncingFromStore = false;
            });
        } catch (error) {
            console.error('[SearchSettings] Failed to save search settings:', error);
            saveState.value = 'error';
        }
    }

    function providerConfig(providerId: SearchProviderId) {
        return draft.value.providers[providerId];
    }

    function updateProviderEnabled(providerId: SearchProviderId, enabled: boolean) {
        if (enabled && isProviderMissingRequiredCredential(providerId)) {
            invalidProviderIds.value = new Set([...invalidProviderIds.value, providerId]);
            draft.value.providers[providerId] = {
                ...draft.value.providers[providerId],
                enabled: false,
            };
            return;
        }
        draft.value.providers[providerId] = {
            ...draft.value.providers[providerId],
            enabled,
        };
        invalidProviderIds.value = removeInvalidProviderId(providerId);
        if (!enabled) {
            resetProviderSelections(providerId);
        }
    }

    function updateProviderCredential(providerId: SearchProviderId, value: string) {
        if (providerRequiresEndpoint(providerId)) {
            draft.value.providers[providerId].endpoint = value;
        } else {
            draft.value.providers[providerId].apiKey = value;
        }
        if (!isProviderMissingRequiredCredential(providerId)) {
            invalidProviderIds.value = removeInvalidProviderId(providerId);
        }
        if (providerConfig(providerId).enabled && isProviderMissingRequiredCredential(providerId)) {
            draft.value.providers[providerId] = {
                ...draft.value.providers[providerId],
                enabled: false,
            };
            resetProviderSelections(providerId);
        }
    }

    function removeInvalidProviderId(providerId: SearchProviderId) {
        const next = new Set(invalidProviderIds.value);
        next.delete(providerId);
        return next;
    }

    function resetProviderSelections(providerId: SearchProviderId) {
        for (const intent of SEARCH_ROUTE_INTENTS) {
            if (draft.value.intentRoutes[intent] === providerId) {
                draft.value.intentRoutes[intent] = 'auto';
            }
        }
        if (draft.value.defaultProvider === providerId) {
            draft.value.defaultProvider = 'auto';
        }
    }

    function providerRequiresApiKey(providerId: SearchProviderId) {
        return SEARCH_PROVIDER_API_KEY_REQUIREMENTS[providerId] === 'required';
    }

    function providerAcceptsApiKey(providerId: SearchProviderId) {
        return SEARCH_PROVIDER_API_KEY_REQUIREMENTS[providerId] !== 'none';
    }

    function providerRequiresEndpoint(providerId: SearchProviderId) {
        return SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS[providerId] === 'required';
    }

    function isProviderMissingRequiredApiKey(providerId: SearchProviderId) {
        return providerRequiresApiKey(providerId) && !providerConfig(providerId).apiKey.trim();
    }

    function isProviderMissingRequiredEndpoint(providerId: SearchProviderId) {
        return providerRequiresEndpoint(providerId) && !providerConfig(providerId).endpoint.trim();
    }

    function isProviderMissingRequiredCredential(providerId: SearchProviderId) {
        return (
            isProviderMissingRequiredApiKey(providerId) ||
            isProviderMissingRequiredEndpoint(providerId)
        );
    }

    function shouldHighlightProviderApiKey(providerId: SearchProviderId) {
        return (
            invalidProviderIds.value.has(providerId) &&
            isProviderMissingRequiredCredential(providerId)
        );
    }

    function canEditProviderApiKey(providerId: SearchProviderId) {
        return (
            toolEnabled.value &&
            (providerConfig(providerId).enabled || invalidProviderIds.value.has(providerId)) &&
            (providerAcceptsApiKey(providerId) || providerRequiresEndpoint(providerId))
        );
    }

    function providerCredentialValue(providerId: SearchProviderId) {
        return providerRequiresEndpoint(providerId)
            ? providerConfig(providerId).endpoint
            : providerConfig(providerId).apiKey;
    }

    function routeValue(intent: SearchRouteIntent): SearchProviderId {
        return draft.value.intentRoutes[intent];
    }

    function updateRoute(intent: SearchRouteIntent, providerId: SearchProviderId) {
        draft.value.intentRoutes[intent] = providerId;
    }
</script>

<template>
    <div class="settings-page" data-testid="settings-search-section">
        <div class="settings-section-stack">
            <header class="settings-page-header flex items-start gap-4">
                <div class="max-w-2xl min-w-0">
                    <h1 class="settings-page-title" data-testid="search-settings-title">
                        {{ t('settings.search.title') }}
                    </h1>
                    <p class="settings-section-description">
                        {{ t('settings.search.description') }}
                    </p>
                </div>
                <button
                    type="button"
                    data-testid="search-enabled-toggle"
                    :aria-pressed="toolEnabled"
                    :disabled="savingToolEnabled"
                    :class="[
                        'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                        toolEnabled ? 'settings-toggle-enabled' : 'bg-neutral-200',
                    ]"
                    @click="toggleToolEnabled"
                >
                    <span
                        :class="[
                            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                            toolEnabled ? 'translate-x-[18px]' : 'translate-x-1',
                        ]"
                    />
                </button>
            </header>

            <fieldset :disabled="!toolEnabled" class="contents">
                <section class="space-y-4">
                    <h2 class="settings-section-title">{{ t('settings.search.section.basic') }}</h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <div
                            class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                        >
                            <div>
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.search.defaultProvider') }}
                                </div>
                                <div class="mt-1 text-xs text-neutral-500">
                                    {{ t('settings.search.defaultProvider.description') }}
                                </div>
                            </div>
                            <CustomSelect
                                v-model="draft.defaultProvider"
                                :options="providerOptions"
                                :disabled="!toolEnabled"
                            />
                        </div>

                        <div
                            class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                        >
                            <div>
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.search.maxResults') }}
                                </div>
                                <div class="mt-1 text-xs text-neutral-500">
                                    {{ t('settings.search.maxResults.description') }}
                                </div>
                            </div>
                            <input
                                v-model.number="draft.maxResults"
                                data-testid="search-max-results-input"
                                type="number"
                                min="1"
                                max="10"
                                class="settings-input w-full disabled:bg-neutral-50"
                                :disabled="!toolEnabled"
                            />
                        </div>

                        <div
                            class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                        >
                            <div>
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.search.timeout') }}
                                </div>
                                <div class="mt-1 text-xs text-neutral-500">
                                    {{ t('settings.search.timeout.description') }}
                                </div>
                            </div>
                            <input
                                v-model.number="draft.timeoutMs"
                                type="number"
                                min="1000"
                                max="60000"
                                step="1000"
                                class="settings-input w-full disabled:bg-neutral-50"
                                :disabled="!toolEnabled"
                            />
                        </div>
                    </div>
                </section>

                <section class="mt-10 space-y-4">
                    <h2 class="settings-section-title">
                        {{ t('settings.search.section.provider') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <div
                            v-for="provider in providerRows"
                            :key="provider.id"
                            data-testid="search-provider-row"
                            class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                        >
                            <div>
                                <div
                                    class="flex min-w-0 flex-wrap items-center gap-2 text-[13px] leading-6 font-normal text-neutral-900"
                                >
                                    <span class="min-w-0 truncate">{{ provider.label }}</span>
                                    <span
                                        v-if="provider.quotaLabel"
                                        :data-testid="`search-provider-quota-${provider.id}`"
                                        class="shrink-0 rounded border border-neutral-300 bg-white px-1 py-0.5 text-[9px] leading-none whitespace-nowrap text-neutral-600 shadow-sm"
                                    >
                                        {{ provider.quotaLabel }}
                                    </span>
                                </div>
                                <div class="mt-1 text-xs text-neutral-500">
                                    {{ provider.description }}
                                </div>
                            </div>
                            <div class="min-w-0">
                                <div class="flex min-w-0 items-center gap-2">
                                    <button
                                        type="button"
                                        :data-testid="`search-provider-toggle-${provider.id}`"
                                        :aria-pressed="providerConfig(provider.id).enabled"
                                        :class="[
                                            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                                            providerConfig(provider.id).enabled
                                                ? 'settings-toggle-enabled'
                                                : 'bg-neutral-200',
                                        ]"
                                        :disabled="!toolEnabled"
                                        @click="
                                            updateProviderEnabled(
                                                provider.id,
                                                !providerConfig(provider.id).enabled
                                            )
                                        "
                                    >
                                        <span
                                            :class="[
                                                'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                                                providerConfig(provider.id).enabled
                                                    ? 'translate-x-[18px]'
                                                    : 'translate-x-1',
                                            ]"
                                        />
                                    </button>
                                    <input
                                        v-if="providerRequiresEndpoint(provider.id)"
                                        :value="providerCredentialValue(provider.id)"
                                        :data-testid="`search-${provider.id}-api-key-input`"
                                        class="focus:border-primary-300 min-w-0 flex-1 rounded-[10px] border border-transparent bg-[#f0f0ef] px-3 py-2 font-serif text-[13px] text-neutral-900 shadow-none transition-colors placeholder:text-neutral-400 hover:bg-[#ececea] focus:bg-white disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-gray-400"
                                        :class="
                                            shouldHighlightProviderApiKey(provider.id)
                                                ? 'border-red-300 bg-red-50 text-red-600'
                                                : ''
                                        "
                                        :placeholder="provider.keyPlaceholder"
                                        :disabled="!canEditProviderApiKey(provider.id)"
                                        type="url"
                                        spellcheck="false"
                                        @input="
                                            updateProviderCredential(
                                                provider.id,
                                                ($event.target as HTMLInputElement).value
                                            )
                                        "
                                    />
                                    <div v-else class="min-w-0 flex-1">
                                        <PasswordInput
                                            :model-value="providerCredentialValue(provider.id)"
                                            :placeholder="provider.keyPlaceholder"
                                            :disabled="!canEditProviderApiKey(provider.id)"
                                            class="!mt-0"
                                            :input-test-id="`search-${provider.id}-api-key-input`"
                                            :input-class="
                                                [
                                                    'h-auto rounded-[10px] border-transparent bg-[#f0f0ef] px-3 py-2 pr-10 text-[13px] text-neutral-900 shadow-none hover:bg-[#ececea] focus:border-primary-300 focus:bg-white disabled:bg-neutral-50 disabled:text-gray-400',
                                                    shouldHighlightProviderApiKey(provider.id)
                                                        ? 'border-red-300 bg-red-50 text-red-600'
                                                        : '',
                                                ].join(' ')
                                            "
                                            @update:model-value="
                                                updateProviderCredential(provider.id, $event)
                                            "
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="mt-10 space-y-4">
                    <h2 class="settings-section-title">
                        {{ t('settings.search.section.routing') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <div
                            v-for="row in routeRows"
                            :key="row.intent"
                            class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                        >
                            <div>
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ row.label }}
                                </div>
                                <div class="mt-1 text-xs text-neutral-500">
                                    {{ row.description }}
                                </div>
                            </div>
                            <CustomSelect
                                :model-value="routeValue(row.intent)"
                                :options="enabledProviderOptions"
                                :disabled="!toolEnabled"
                                @update:model-value="
                                    updateRoute(row.intent, $event as SearchProviderId)
                                "
                            />
                        </div>
                    </div>
                </section>

                <section class="mt-10 space-y-4">
                    <h2 class="settings-section-title">
                        {{ t('settings.search.section.advanced') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <div
                            v-for="row in advancedRows"
                            :key="row.key"
                            class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                        >
                            <div>
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ row.label }}
                                </div>
                                <div class="mt-1 text-xs text-neutral-500">
                                    {{ row.description }}
                                </div>
                            </div>
                            <button
                                type="button"
                                :data-testid="`search-advanced-toggle-${row.key}`"
                                :aria-pressed="draft[row.key]"
                                :class="[
                                    'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                                    draft[row.key] ? 'settings-toggle-enabled' : 'bg-neutral-200',
                                ]"
                                :disabled="!toolEnabled"
                                @click="draft[row.key] = !draft[row.key]"
                            >
                                <span
                                    :class="[
                                        'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                                        draft[row.key] ? 'translate-x-[18px]' : 'translate-x-1',
                                    ]"
                                />
                            </button>
                        </div>
                    </div>
                </section>
            </fieldset>
        </div>
    </div>
</template>
