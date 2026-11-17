<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { findBuiltInToolByToolId, updateBuiltInTool } from '@database/queries';
    import { log } from '@services/ObservabilityService';
    import {
        parseSearchSettingsConfig,
        SEARCH_PROVIDER_API_KEY_REQUIREMENTS,
        SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS,
        SEARCH_PROVIDER_IDS,
        SEARCH_ROUTE_INTENTS,
        SEARCH_ROUTING_STRATEGIES,
        SEARCH_SOURCES,
        type SearchProviderId,
        type SearchRouteIntent,
        type SearchRoutingStrategy,
        type SearchSettingsConfig,
        type SearchSource,
        serializeSearchSettingsConfig,
        WEB_FETCH_STRATEGIES,
        type WebFetchStrategy,
    } from '@services/SettingsService/domain';
    import { storeToRefs } from 'pinia';
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
    import { VueDraggable } from 'vue-draggable-plus';

    import doubaoLogo from '@/assets/logos/models/doubao.png';
    import anysearchLogo from '@/assets/logos/providers/anysearch.png';
    import braveLogo from '@/assets/logos/providers/brave.svg';
    import deepseekLogo from '@/assets/logos/providers/deepseek.png';
    import exaLogo from '@/assets/logos/providers/exa.svg';
    import firecrawlLogo from '@/assets/logos/providers/firecrawl.svg';
    import githubLogo from '@/assets/logos/providers/github.svg';
    import grokLogo from '@/assets/logos/providers/grok-search.png';
    import keenableLogo from '@/assets/logos/providers/keenable.png';
    import openalexLogo from '@/assets/logos/providers/openalex.png';
    import qianfanLogo from '@/assets/logos/providers/qianfan.svg';
    import searxngLogo from '@/assets/logos/providers/searxng.svg';
    import scholarLogo from '@/assets/logos/providers/semantic-scholar.png';
    import serperLogo from '@/assets/logos/providers/serper.png';
    import tavilyLogo from '@/assets/logos/providers/tavily.svg';
    import tinyfishLogo from '@/assets/logos/providers/tinyfish.svg';
    import wikipediaLogo from '@/assets/logos/providers/wikipedia.png';
    import yuanbaoLogo from '@/assets/logos/providers/yuanbao.svg';
    import zhihuLogo from '@/assets/logos/providers/zhihu.svg';
    import { type MessageKey, t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';

    import { hasSettingsDraftChanges, mergeSettingsDraft } from '../../settingsDraftSync';
    import SearchProviderCard from './SearchProviderCard.vue';

    defineOptions({ name: 'SettingsSearchSection' });

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);
    const draft = ref<SearchSettingsConfig>(cloneConfig(settings.value.searchSettings));
    let syncedConfig = cloneConfig(settings.value.searchSettings);
    const toolRowId = ref<number | null>(null);
    const toolEnabled = ref(true);
    const savingToolEnabled = ref(false);
    const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const invalidProviderIds = ref<Set<SearchProviderId>>(new Set());
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let isSyncingFromStore = false;
    const providerLogos: Partial<Record<SearchProviderId, string>> = {
        anysearch: anysearchLogo,
        brave: braveLogo,
        deepseek: deepseekLogo,
        exa: exaLogo,
        firecrawl: firecrawlLogo,
        github: githubLogo,
        grok: grokLogo,
        keenable: keenableLogo,
        openalex: openalexLogo,
        searxng: searxngLogo,
        semantic_scholar: scholarLogo,
        tavily: tavilyLogo,
        wikipedia: wikipediaLogo,
        yuanbao: yuanbaoLogo,
        zhihu: zhihuLogo,
        doubao: doubaoLogo,
        qianfan: qianfanLogo,
        tinyfish: tinyfishLogo,
        serper: serperLogo,
    };
    const sourceMessages: Record<SearchSource, MessageKey> = {
        general: 'settings.search.source.general',
        news: 'settings.search.source.news',
        community: 'settings.search.source.community',
        academic: 'settings.search.source.academic',
        code: 'settings.search.source.code',
        official: 'settings.search.source.official',
        realtime: 'settings.search.source.realtime',
    };
    const providerGroups: Array<{ label: MessageKey; ids: SearchProviderId[] }> = [
        {
            label: 'settings.search.group.general',
            ids: [
                'anysearch',
                'keenable',
                'tavily',
                'exa',
                'brave',
                'firecrawl',
                'serper',
                'grok',
                'tinyfish',
            ],
        },
        {
            label: 'settings.search.group.chinese',
            ids: ['zhihu', 'yuanbao', 'doubao', 'qianfan', 'deepseek'],
        },
        {
            label: 'settings.search.group.specialist',
            ids: ['wikipedia', 'openalex', 'semantic_scholar', 'github'],
        },
        { label: 'settings.search.group.selfHosted', ids: ['searxng'] },
    ];

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
        deepseek: {
            label: 'settings.search.provider.deepseek',
            description: 'settings.search.provider.deepseek.description',
            keyPlaceholder: 'settings.search.provider.deepseek.keyPlaceholder',
            quotaLabel: 'settings.search.provider.deepseek.quota',
        },
        keenable: {
            label: 'settings.search.provider.keenable',
            description: 'settings.search.provider.keenable.description',
            keyPlaceholder: 'settings.search.provider.keenable.keyPlaceholder',
            quotaLabel: 'settings.search.provider.keenable.quota',
        },
        zhihu: {
            label: 'settings.search.provider.zhihu',
            description: 'settings.search.provider.zhihu.description',
            keyPlaceholder: 'settings.search.provider.zhihu.keyPlaceholder',
            quotaLabel: 'settings.search.provider.zhihu.quota',
        },
        yuanbao: {
            label: 'settings.search.provider.yuanbao',
            description: 'settings.search.provider.yuanbao.description',
            keyPlaceholder: 'settings.search.provider.yuanbao.keyPlaceholder',
            quotaLabel: 'settings.search.provider.yuanbao.quota',
        },
        grok: {
            label: 'settings.search.provider.grok',
            description: 'settings.search.provider.grok.description',
            keyPlaceholder: 'settings.search.provider.grok.keyPlaceholder',
            quotaLabel: 'settings.search.provider.grok.quota',
        },
        doubao: {
            label: 'settings.search.provider.doubao',
            description: 'settings.search.provider.doubao.description',
            keyPlaceholder: 'settings.search.provider.doubao.keyPlaceholder',
            quotaLabel: 'settings.search.provider.doubao.quota',
        },
        qianfan: {
            label: 'settings.search.provider.qianfan',
            description: 'settings.search.provider.qianfan.description',
            keyPlaceholder: 'settings.search.provider.qianfan.keyPlaceholder',
            quotaLabel: 'settings.search.provider.qianfan.quota',
        },
        tinyfish: {
            label: 'settings.search.provider.tinyfish',
            description: 'settings.search.provider.tinyfish.description',
            keyPlaceholder: 'settings.search.provider.tinyfish.keyPlaceholder',
            quotaLabel: 'settings.search.provider.tinyfish.quota',
        },
        serper: {
            label: 'settings.search.provider.serper',
            description: 'settings.search.provider.serper.description',
            keyPlaceholder: 'settings.search.provider.serper.keyPlaceholder',
            quotaLabel: 'settings.search.provider.serper.quota',
        },
    };

    const strategyMessages: Record<
        SearchRoutingStrategy,
        { label: MessageKey; description: MessageKey }
    > = {
        model: {
            label: 'settings.search.strategy.model',
            description: 'settings.search.strategy.model.description',
        },
        intent: {
            label: 'settings.search.strategy.intent',
            description: 'settings.search.strategy.intent.description',
        },
        capability: {
            label: 'settings.search.strategy.capability',
            description: 'settings.search.strategy.capability.description',
        },
        manual: {
            label: 'settings.search.strategy.manual',
            description: 'settings.search.strategy.manual.description',
        },
        priority: {
            label: 'settings.search.strategy.priority',
            description: 'settings.search.strategy.priority.description',
        },
        parallel: {
            label: 'settings.search.strategy.parallel',
            description: 'settings.search.strategy.parallel.description',
        },
    };

    const fetchStrategyMessages: Record<
        WebFetchStrategy,
        { label: MessageKey; description: MessageKey }
    > = {
        direct: {
            label: 'settings.search.fetchStrategy.direct',
            description: 'settings.search.fetchStrategy.direct.description',
        },
        fallback: {
            label: 'settings.search.fetchStrategy.fallback',
            description: 'settings.search.fetchStrategy.fallback.description',
        },
        prefer: {
            label: 'settings.search.fetchStrategy.prefer',
            description: 'settings.search.fetchStrategy.prefer.description',
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

    const strategyOptions = computed(() =>
        SEARCH_ROUTING_STRATEGIES.map((strategy) => ({
            value: strategy,
            label: t(strategyMessages[strategy].label),
        }))
    );

    const strategyDescription = computed(() =>
        t(strategyMessages[draft.value.routingStrategy].description)
    );

    const fetchStrategyOptions = computed(() =>
        WEB_FETCH_STRATEGIES.map((strategy) => ({
            value: strategy,
            label: t(fetchStrategyMessages[strategy].label),
        }))
    );

    const fetchStrategyDescription = computed(() =>
        t(fetchStrategyMessages[draft.value.fetchStrategy].description)
    );

    const priorityRows = computed<SearchProviderId[]>({
        get: () => draft.value.providerPriority.filter((id) => providerConfig(id).enabled),
        set: (next) => {
            const keep = draft.value.providerPriority.filter((id) => !next.includes(id));
            draft.value.providerPriority = [...next, ...keep];
        },
    });

    const disabledPriorityCount = computed(
        () => draft.value.providerPriority.filter((id) => !providerConfig(id).enabled).length
    );

    const routeRows = computed(() =>
        SEARCH_ROUTE_INTENTS.map((intent) => ({
            intent,
            label: t(intentMessages[intent].label),
            description: t(intentMessages[intent].description),
        }))
    );

    const advancedRows = computed<
        Array<{
            key: 'fallbackEnabled' | 'preferOfficialSources';
            label: string;
            description: string;
        }>
    >(() => [
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
            const incoming = cloneConfig(config);
            isSyncingFromStore = true;
            draft.value = mergeSettingsDraft(syncedConfig, draft.value, incoming);
            syncedConfig = incoming;
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
            log.error('[SearchSettings] Failed to load web_search tool state:', error);
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
            log.error('[SearchSettings] Failed to toggle web_search:', error);
        } finally {
            savingToolEnabled.value = false;
        }
    }

    async function saveSettings() {
        if (!canSave.value) return;
        saveState.value = 'saving';
        try {
            const submitted = cloneConfig(draft.value);
            const incoming = cloneConfig(settings.value.searchSettings);
            await settingsStore.updateSearchSettings(
                mergeSettingsDraft(syncedConfig, submitted, incoming)
            );
            await nextTick();
            saveState.value = 'saved';
            syncedConfig = cloneConfig(settings.value.searchSettings);
            if (hasSettingsDraftChanges(syncedConfig, cloneConfig(draft.value))) {
                scheduleAutoSave();
            }
        } catch (error) {
            log.error('[SearchSettings] Failed to save search settings:', error);
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
            invalidProviderIds.value = new Set([...invalidProviderIds.value, providerId]);
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
        for (const source of SEARCH_SOURCES) {
            if (draft.value.sourceRoutes[source] === providerId)
                draft.value.sourceRoutes[source] = 'auto';
        }
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

    function moveProviderToTop(providerId: SearchProviderId) {
        const priority = [...draft.value.providerPriority];
        const index = priority.indexOf(providerId);
        if (index <= 0) return;
        priority.splice(index, 1);
        priority.unshift(providerId);
        draft.value.providerPriority = priority;
    }
</script>

<template>
    <div class="settings-page @container" data-testid="settings-search-section">
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
                <Switch
                    size="lg"
                    class="ml-auto shrink-0"
                    data-testid="search-enabled-toggle"
                    :aria-label="t('settings.search.title')"
                    :model-value="toolEnabled"
                    :disabled="savingToolEnabled"
                    @update:model-value="toggleToolEnabled"
                />
            </header>

            <fieldset :disabled="!toolEnabled" class="contents">
                <section class="space-y-4">
                    <h2 class="settings-section-title">{{ t('settings.search.section.basic') }}</h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <SettingsRow
                            data-settings-search-target="search-default-provider"
                            control-width="320"
                            :label="t('settings.search.defaultProvider')"
                            :description="t('settings.search.defaultProvider.description')"
                        >
                            <CustomSelect
                                v-model="draft.defaultProvider"
                                :options="providerOptions"
                                :disabled="!toolEnabled"
                            />
                        </SettingsRow>

                        <SettingsRow
                            data-settings-search-target="search-max-results"
                            control-width="320"
                            :label="t('settings.search.maxResults')"
                            :description="t('settings.search.maxResults.description')"
                        >
                            <Input
                                v-model.number="draft.maxResults"
                                variant="filled"
                                data-testid="search-max-results-input"
                                type="number"
                                min="1"
                                class="w-full disabled:bg-neutral-50"
                                :disabled="!toolEnabled"
                            />
                        </SettingsRow>

                        <SettingsRow
                            data-settings-search-target="search-timeout"
                            control-width="320"
                            :label="t('settings.search.timeout')"
                            :description="t('settings.search.timeout.description')"
                        >
                            <Input
                                v-model.number="draft.timeoutMs"
                                variant="filled"
                                type="number"
                                min="1000"
                                max="300000"
                                step="1000"
                                class="w-full disabled:bg-neutral-50"
                                :disabled="!toolEnabled"
                            />
                        </SettingsRow>
                    </div>
                </section>

                <section class="mt-10 space-y-4" data-settings-search-target="search-strategy">
                    <h2 class="settings-section-title">
                        {{ t('settings.search.section.strategy') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <SettingsRow
                            data-settings-search-target="search-strategy"
                            control-width="320"
                            :label="t('settings.search.strategy')"
                            :description="strategyDescription"
                        >
                            <CustomSelect
                                v-model="draft.routingStrategy"
                                data-testid="search-strategy-select"
                                :options="strategyOptions"
                                :disabled="!toolEnabled"
                            />
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="search-fetch-strategy"
                            control-width="320"
                            :label="t('settings.search.fetchStrategy')"
                            :description="fetchStrategyDescription"
                        >
                            <CustomSelect
                                v-model="draft.fetchStrategy"
                                data-testid="search-fetch-strategy-select"
                                :options="fetchStrategyOptions"
                                :disabled="!toolEnabled"
                            />
                        </SettingsRow>
                        <SettingsRow
                            v-if="draft.routingStrategy === 'parallel'"
                            control-width="320"
                            :label="t('settings.search.parallelProviderCount')"
                            :description="t('settings.search.parallelProviderCount.description')"
                        >
                            <Input
                                v-model.number="draft.parallelProviderCount"
                                variant="filled"
                                data-testid="search-parallel-count-input"
                                type="number"
                                min="2"
                                :max="SEARCH_PROVIDER_IDS.length - 1"
                                class="w-full"
                                :disabled="!toolEnabled"
                            />
                        </SettingsRow>
                    </div>
                </section>

                <section class="mt-10 space-y-4" data-settings-search-target="search-providers">
                    <h2 class="settings-section-title">
                        {{ t('settings.search.section.provider') }}
                    </h2>
                    <div v-for="group in providerGroups" :key="group.label" class="space-y-3">
                        <h3 class="text-compact font-medium text-text-secondary">
                            {{ t(group.label) }}
                        </h3>
                        <div class="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
                            <SearchProviderCard
                                v-for="providerId in group.ids"
                                :id="providerId"
                                :key="providerId"
                                :label="t(providerMessages[providerId].label)"
                                :description="t(providerMessages[providerId].description)"
                                :logo="providerLogos[providerId]!"
                                :quota="
                                    providerMessages[providerId].quotaLabel
                                        ? t(providerMessages[providerId].quotaLabel!)
                                        : null
                                "
                                :enabled="providerConfig(providerId).enabled"
                                :disabled="!toolEnabled"
                                :credential="providerCredentialValue(providerId)"
                                :placeholder="t(providerMessages[providerId].keyPlaceholder)"
                                :editable="
                                    providerAcceptsApiKey(providerId) ||
                                    providerRequiresEndpoint(providerId)
                                "
                                :endpoint="providerRequiresEndpoint(providerId)"
                                :invalid="shouldHighlightProviderApiKey(providerId)"
                                @enabled="updateProviderEnabled(providerId, $event)"
                                @credential="updateProviderCredential(providerId, $event)"
                            />
                        </div>
                    </div>
                </section>

                <section
                    v-if="
                        draft.routingStrategy === 'intent' || draft.routingStrategy === 'capability'
                    "
                    class="mt-10 space-y-4"
                    data-settings-search-target="search-routing"
                >
                    <h2 class="settings-section-title">
                        {{ t('settings.search.section.routing') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <SettingsRow
                            v-for="source in draft.routingStrategy === 'capability'
                                ? SEARCH_SOURCES
                                : []"
                            :key="source"
                            :label="t(sourceMessages[source])"
                            control-width="320"
                        >
                            <CustomSelect
                                v-model="draft.sourceRoutes[source]"
                                :data-testid="`search-source-route-${source}`"
                                :options="enabledProviderOptions"
                                :disabled="!toolEnabled"
                            />
                        </SettingsRow>

                        <SettingsRow
                            v-for="row in draft.routingStrategy === 'intent' ? routeRows : []"
                            :key="row.intent"
                            control-width="320"
                            :label="row.label"
                            :description="row.description"
                        >
                            <CustomSelect
                                :model-value="routeValue(row.intent)"
                                :options="enabledProviderOptions"
                                :disabled="!toolEnabled"
                                @update:model-value="
                                    updateRoute(row.intent, $event as SearchProviderId)
                                "
                            />
                        </SettingsRow>
                    </div>
                </section>

                <section
                    v-if="['priority', 'parallel'].includes(draft.routingStrategy)"
                    class="mt-10 space-y-4"
                    data-settings-search-target="search-priority"
                >
                    <div class="flex items-start justify-between gap-4">
                        <div>
                            <h2 class="settings-section-title">
                                {{ t('settings.search.priority') }}
                            </h2>
                            <p class="settings-section-description">
                                {{ t('settings.search.priority.hint') }}
                            </p>
                        </div>
                    </div>
                    <p v-if="disabledPriorityCount > 0" class="text-caption text-text-tertiary">
                        {{
                            t('settings.search.priority.disabledHint', {
                                count: disabledPriorityCount,
                            })
                        }}
                    </p>
                    <VueDraggable
                        v-model="priorityRows"
                        tag="ol"
                        data-testid="search-provider-priority"
                        class="max-h-96 overflow-x-hidden overflow-y-auto rounded-card border border-border-subtle bg-surface-floating"
                        handle="[data-search-priority-handle]"
                        :animation="160"
                        :force-fallback="true"
                        :disabled="!toolEnabled"
                        ghost-class="opacity-40"
                    >
                        <li
                            v-for="(providerId, index) in priorityRows"
                            :key="providerId"
                            :data-provider="providerId"
                            class="flex items-center gap-3 border-b border-border-subtle px-3 py-2.5 last:border-b-0"
                            :class="providerConfig(providerId).enabled ? '' : 'opacity-50'"
                        >
                            <button
                                type="button"
                                class="inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary active:cursor-grabbing disabled:cursor-default"
                                :disabled="!toolEnabled || priorityRows.length < 2"
                                :aria-label="
                                    t('settings.search.priority.drag', {
                                        name: t(providerMessages[providerId].label),
                                    })
                                "
                                data-search-priority-handle
                                style="touch-action: none"
                            >
                                <span class="grid grid-cols-2 gap-0.5">
                                    <span
                                        v-for="dot in 6"
                                        :key="dot"
                                        class="size-1 rounded-full bg-current"
                                    />
                                </span>
                            </button>
                            <span class="w-5 shrink-0 text-caption text-text-tertiary tabular-nums">
                                {{ index + 1 }}
                            </span>
                            <img
                                v-if="providerLogos[providerId]"
                                :src="providerLogos[providerId]"
                                alt=""
                                class="size-5 shrink-0 object-contain"
                            />
                            <span class="min-w-0 flex-1 truncate text-compact text-settings-text">
                                {{ t(providerMessages[providerId].label) }}
                            </span>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                class="shrink-0"
                                :data-testid="`search-priority-top-${providerId}`"
                                :disabled="!toolEnabled || index === 0"
                                :aria-label="
                                    t('settings.search.priority.moveToTop', {
                                        name: t(providerMessages[providerId].label),
                                    })
                                "
                                @click="moveProviderToTop(providerId)"
                            >
                                <AppIcon name="chevron-up" class="size-3.5" />
                            </Button>
                        </li>
                    </VueDraggable>
                </section>

                <section class="mt-10 space-y-4">
                    <h2 class="settings-section-title">
                        {{ t('settings.search.section.advanced') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <SettingsRow
                            v-for="row in advancedRows"
                            :key="row.key"
                            :data-settings-search-target="`search-${row.key}`"
                            control-width="auto"
                            :label="row.label"
                            :description="row.description"
                        >
                            <Switch
                                size="lg"
                                class="shrink-0"
                                :data-testid="`search-advanced-toggle-${row.key}`"
                                :aria-label="row.label"
                                :model-value="draft[row.key]"
                                :disabled="!toolEnabled"
                                @update:model-value="draft[row.key] = !draft[row.key]"
                            />
                        </SettingsRow>
                    </div>
                </section>
            </fieldset>
            <p v-if="saveState === 'error'" role="alert" class="text-compact text-text-danger">
                {{ t('settings.search.saveError') }}
            </p>
        </div>
    </div>
</template>
