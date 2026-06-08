<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import AppIcon from '@components/AppIcon.vue';
    import LoadingState from '@components/LoadingState.vue';
    import { computed, onMounted, ref } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import {
        APP_USE_ADAPTER_IDS,
        type AppUseAdapterId,
        type AppUseMode,
        type AppUseToolConfig,
        DEFAULT_APP_USE_TOOL_CONFIG,
        parseAppUseToolConfig,
        serializeAppUseToolConfig,
    } from '@/services/BuiltInToolService/tools/appUse';

    import BuiltInToolLogViewer from '../BuiltInTools/components/BuiltInToolLogViewer.vue';
    import type { BuiltInToolEntity } from '../BuiltInTools/types';
    import { loadBuiltInToolQueries } from '../BuiltInTools/types';
    import SectionTabs, { type SectionTabItem } from '../SectionTabs.vue';

    defineOptions({
        name: 'SettingsAppUseSection',
    });

    const APP_USE_TOOL_IDS = ['app_session', 'app_observe', 'app_act'] as const;

    const APP_USE_ADAPTER_LABEL_KEYS: Record<AppUseAdapterId, MessageKey> = {
        office_word: 'settings.appUse.adapter.officeWord',
        office_excel: 'settings.appUse.adapter.officeExcel',
        office_powerpoint: 'settings.appUse.adapter.officePowerPoint',
        wps_writer: 'settings.appUse.adapter.wpsWriter',
        wps_spreadsheet: 'settings.appUse.adapter.wpsSpreadsheet',
        wps_presentation: 'settings.appUse.adapter.wpsPresentation',
        photoshop: 'settings.appUse.adapter.photoshop',
        illustrator: 'settings.appUse.adapter.illustrator',
    };

    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const tools = ref<BuiltInToolEntity[]>([]);
    const config = ref<AppUseToolConfig>({ ...DEFAULT_APP_USE_TOOL_CONFIG });
    const loading = ref(true);
    const saving = ref(false);
    const activeTab = ref<'settings' | 'logs'>('settings');
    const selectedLogToolId = ref<(typeof APP_USE_TOOL_IDS)[number]>('app_act');
    const tabs = computed<SectionTabItem<'settings' | 'logs'>[]>(() => [
        { value: 'settings', label: t('settings.appUse.tabs.settings') },
        { value: 'logs', label: t('settings.appUse.tabs.logs') },
    ]);

    const appUseTools = computed(() =>
        APP_USE_TOOL_IDS.map((toolId) =>
            tools.value.find((tool) => tool.tool_id === toolId)
        ).filter((tool): tool is BuiltInToolEntity => Boolean(tool))
    );
    const allEnabled = computed(
        () =>
            appUseTools.value.length === APP_USE_TOOL_IDS.length &&
            appUseTools.value.every((tool) => tool.enabled === 1)
    );
    const missingTools = computed(() => appUseTools.value.length !== APP_USE_TOOL_IDS.length);
    const selectedLogTool = computed(
        () =>
            appUseTools.value.find((tool) => tool.tool_id === selectedLogToolId.value) ??
            appUseTools.value[0] ??
            null
    );

    const adapterItems = computed(() =>
        APP_USE_ADAPTER_IDS.map((adapterId) => ({
            id: adapterId,
            label: t(APP_USE_ADAPTER_LABEL_KEYS[adapterId]),
            enabled: config.value.adapters[adapterId],
        }))
    );

    function readSharedConfig(nextTools: BuiltInToolEntity[]): AppUseToolConfig {
        const preferredTool = APP_USE_TOOL_IDS.map((toolId) =>
            nextTools.find((tool) => tool.tool_id === toolId)
        ).find((tool): tool is BuiltInToolEntity => Boolean(tool));

        return parseAppUseToolConfig(preferredTool?.config_json ?? null);
    }

    function patchLocalTool(toolId: string, patch: Partial<BuiltInToolEntity>) {
        tools.value = tools.value.map((tool) =>
            tool.tool_id === toolId
                ? {
                      ...tool,
                      ...patch,
                  }
                : tool
        );
    }

    async function loadTools() {
        loading.value = true;
        try {
            const queries = await loadBuiltInToolQueries();
            const nextTools = (await queries.findAllBuiltInTools()).filter((tool) =>
                APP_USE_TOOL_IDS.includes(tool.tool_id as (typeof APP_USE_TOOL_IDS)[number])
            );
            tools.value = nextTools;
            config.value = readSharedConfig(nextTools);
        } catch (error) {
            console.error('[AppUseSettings] Failed to load App Use tools:', error);
            alertMessage.value?.error(t('settings.appUse.loadFailed'), 6000);
            tools.value = [];
            config.value = { ...DEFAULT_APP_USE_TOOL_CONFIG };
        } finally {
            loading.value = false;
        }
    }

    async function saveSharedConfig(nextConfig: AppUseToolConfig) {
        config.value = nextConfig;
        if (appUseTools.value.length === 0) {
            return;
        }

        saving.value = true;
        const configJson = serializeAppUseToolConfig(nextConfig);
        try {
            const queries = await loadBuiltInToolQueries();
            await Promise.all(
                appUseTools.value.map(async (tool) => {
                    const updatedTool = await queries.updateBuiltInTool(tool.id, {
                        config_json: configJson,
                    });
                    patchLocalTool(tool.tool_id, {
                        config_json: updatedTool?.config_json ?? configJson,
                        updated_at: updatedTool?.updated_at ?? tool.updated_at,
                    });
                })
            );
        } catch (error) {
            console.error('[AppUseSettings] Failed to save App Use config:', error);
            alertMessage.value?.error(t('settings.appUse.saveFailed'), 6000);
        } finally {
            saving.value = false;
        }
    }

    async function setMode(mode: AppUseMode) {
        if (config.value.mode === mode) {
            return;
        }

        await saveSharedConfig({
            ...config.value,
            mode,
        });
    }

    async function setAdapterEnabled(adapterId: AppUseAdapterId, enabled: boolean) {
        if (config.value.adapters[adapterId] === enabled) {
            return;
        }

        await saveSharedConfig({
            ...config.value,
            adapters: {
                ...config.value.adapters,
                [adapterId]: enabled,
            },
        });
    }

    async function setBackgroundOperation(enabled: boolean) {
        if (config.value.allowBackgroundOperation === enabled) {
            return;
        }

        await saveSharedConfig({
            ...config.value,
            allowBackgroundOperation: enabled,
        });
    }

    async function setNumericLimit(key: 'timeoutMs' | 'maxOutputChars', rawValue: string) {
        const parsedValue = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsedValue) || config.value[key] === parsedValue) {
            return;
        }

        await saveSharedConfig({
            ...config.value,
            [key]: parsedValue,
        });
    }

    async function setEnabled(enabled: boolean) {
        if (appUseTools.value.length === 0 || allEnabled.value === enabled) {
            return;
        }

        saving.value = true;
        try {
            const queries = await loadBuiltInToolQueries();
            await Promise.all(
                appUseTools.value.map(async (tool) => {
                    const updatedTool = await queries.updateBuiltInTool(tool.id, {
                        enabled: enabled ? 1 : 0,
                    });
                    patchLocalTool(tool.tool_id, {
                        enabled: updatedTool?.enabled ?? (enabled ? 1 : 0),
                        updated_at: updatedTool?.updated_at ?? tool.updated_at,
                    });
                })
            );
        } catch (error) {
            console.error('[AppUseSettings] Failed to update App Use enabled state:', error);
            alertMessage.value?.error(t('settings.appUse.saveFailed'), 6000);
        } finally {
            saving.value = false;
        }
    }

    onMounted(() => {
        void loadTools();
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div
        class="settings-page settings-scrollbar h-full overflow-y-auto"
        data-testid="settings-app-use-section"
    >
        <div class="settings-section-stack">
            <header class="settings-page-header">
                <h1 class="settings-page-title">{{ t('settings.appUse.title') }}</h1>
            </header>

            <LoadingState v-if="loading" variant="brand" fill="min" />

            <div
                v-else-if="missingTools"
                class="settings-row-group px-5 py-10 text-center"
                data-testid="settings-app-use-empty"
            >
                <AppIcon name="wrench" class="mx-auto h-11 w-11 text-neutral-300" />
                <h2 class="mt-4 text-[15px] font-medium text-neutral-950">
                    {{ t('settings.appUse.emptyTools') }}
                </h2>
                <p class="mt-2 text-sm leading-6 text-neutral-500">
                    {{ t('settings.appUse.emptyToolsDescription') }}
                </p>
            </div>

            <template v-else>
                <SectionTabs v-model="activeTab" :tabs="tabs" />

                <template v-if="activeTab === 'settings'">
                    <section class="space-y-4">
                        <div>
                            <h2 class="settings-section-title">
                                {{ t('settings.appUse.access.title') }}
                            </h2>
                            <p class="settings-section-description">
                                {{ t('settings.appUse.access.description') }}
                            </p>
                        </div>

                        <div class="settings-row-group divide-y divide-neutral-200/70">
                            <div
                                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                            >
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.appUse.enabled') }}
                                </div>
                                <button
                                    type="button"
                                    data-testid="settings-app-use-enabled-toggle"
                                    :aria-pressed="allEnabled"
                                    :disabled="saving"
                                    :class="[
                                        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-wait disabled:opacity-60',
                                        allEnabled ? 'settings-toggle-enabled' : 'bg-neutral-200',
                                    ]"
                                    @click="setEnabled(!allEnabled)"
                                >
                                    <span
                                        :class="[
                                            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                                            allEnabled ? 'translate-x-[18px]' : 'translate-x-1',
                                        ]"
                                    />
                                </button>
                            </div>

                            <div class="px-5 py-4">
                                <div
                                    class="mb-3 text-[13px] leading-6 font-normal text-neutral-900"
                                >
                                    {{ t('settings.appUse.mode.title') }}
                                </div>
                                <div class="inline-flex rounded-[10px] bg-neutral-100 p-1">
                                    <button
                                        type="button"
                                        data-testid="settings-app-use-mode-read-only"
                                        :aria-pressed="config.mode === 'read_only'"
                                        :disabled="saving"
                                        :class="[
                                            'rounded-[8px] px-3 py-1.5 text-[12px] transition-colors disabled:cursor-wait disabled:opacity-60',
                                            config.mode === 'read_only'
                                                ? 'bg-white text-neutral-950 shadow-sm'
                                                : 'text-neutral-500 hover:text-neutral-800',
                                        ]"
                                        @click="setMode('read_only')"
                                    >
                                        {{ t('settings.appUse.mode.readOnly') }}
                                    </button>
                                    <button
                                        type="button"
                                        data-testid="settings-app-use-mode-interactive"
                                        :aria-pressed="config.mode === 'interactive'"
                                        :disabled="saving"
                                        :class="[
                                            'rounded-[8px] px-3 py-1.5 text-[12px] transition-colors disabled:cursor-wait disabled:opacity-60',
                                            config.mode === 'interactive'
                                                ? 'bg-white text-neutral-950 shadow-sm'
                                                : 'text-neutral-500 hover:text-neutral-800',
                                        ]"
                                        @click="setMode('interactive')"
                                    >
                                        {{ t('settings.appUse.mode.interactive') }}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="space-y-4">
                        <div>
                            <h2 class="settings-section-title">
                                {{ t('settings.appUse.adapters.title') }}
                            </h2>
                            <p class="settings-section-description">
                                {{ t('settings.appUse.adapters.description') }}
                            </p>
                        </div>

                        <div class="settings-row-group divide-y divide-neutral-200/70">
                            <div
                                v-for="adapter in adapterItems"
                                :key="adapter.id"
                                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                            >
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ adapter.label }}
                                </div>
                                <button
                                    type="button"
                                    :data-testid="`settings-app-use-adapter-${adapter.id}`"
                                    :aria-pressed="adapter.enabled"
                                    :disabled="saving"
                                    :class="[
                                        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-wait disabled:opacity-60',
                                        adapter.enabled
                                            ? 'settings-toggle-enabled'
                                            : 'bg-neutral-200',
                                    ]"
                                    @click="setAdapterEnabled(adapter.id, !adapter.enabled)"
                                >
                                    <span
                                        :class="[
                                            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                                            adapter.enabled
                                                ? 'translate-x-[18px]'
                                                : 'translate-x-1',
                                        ]"
                                    />
                                </button>
                            </div>
                        </div>
                    </section>

                    <section class="space-y-4">
                        <div>
                            <h2 class="settings-section-title">
                                {{ t('settings.appUse.safety.title') }}
                            </h2>
                            <p class="settings-section-description">
                                {{ t('settings.appUse.safety.description') }}
                            </p>
                        </div>

                        <div class="settings-row-group divide-y divide-neutral-200/70">
                            <div
                                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                            >
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.appUse.safety.approvalMode') }}
                                </div>
                                <div class="text-right text-[12px] text-neutral-500">
                                    {{ t('settings.appUse.safety.alwaysApprove') }}
                                </div>
                            </div>

                            <div
                                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                            >
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.appUse.safety.readScope') }}
                                </div>
                                <div class="text-right text-[12px] text-neutral-500">
                                    {{ t('settings.appUse.safety.activeOnly') }}
                                </div>
                            </div>

                            <div
                                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                            >
                                <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.appUse.safety.backgroundOperation') }}
                                </div>
                                <button
                                    type="button"
                                    data-testid="settings-app-use-background-toggle"
                                    :aria-pressed="config.allowBackgroundOperation"
                                    :disabled="saving"
                                    :class="[
                                        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-wait disabled:opacity-60',
                                        config.allowBackgroundOperation
                                            ? 'settings-toggle-enabled'
                                            : 'bg-neutral-200',
                                    ]"
                                    @click="
                                        setBackgroundOperation(!config.allowBackgroundOperation)
                                    "
                                >
                                    <span
                                        :class="[
                                            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                                            config.allowBackgroundOperation
                                                ? 'translate-x-[18px]'
                                                : 'translate-x-1',
                                        ]"
                                    />
                                </button>
                            </div>

                            <div
                                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                            >
                                <label class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.appUse.safety.timeoutMs') }}
                                </label>
                                <input
                                    data-testid="settings-app-use-timeout-ms"
                                    class="w-[180px] rounded-[10px] border-transparent bg-[#f0f0ef] px-3 py-2 text-right text-[12px] text-neutral-900 transition-colors hover:bg-[#ececea] focus:border-neutral-300 focus:bg-white focus:outline-none"
                                    type="number"
                                    min="1000"
                                    max="120000"
                                    step="1000"
                                    :value="config.timeoutMs"
                                    :disabled="saving"
                                    @change="
                                        setNumericLimit(
                                            'timeoutMs',
                                            ($event.target as HTMLInputElement).value
                                        )
                                    "
                                />
                            </div>

                            <div
                                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                            >
                                <label class="text-[13px] leading-6 font-normal text-neutral-900">
                                    {{ t('settings.appUse.safety.maxOutputChars') }}
                                </label>
                                <input
                                    data-testid="settings-app-use-max-output-chars"
                                    class="w-[180px] rounded-[10px] border-transparent bg-[#f0f0ef] px-3 py-2 text-right text-[12px] text-neutral-900 transition-colors hover:bg-[#ececea] focus:border-neutral-300 focus:bg-white focus:outline-none"
                                    type="number"
                                    min="1000"
                                    max="50000"
                                    step="1000"
                                    :value="config.maxOutputChars"
                                    :disabled="saving"
                                    @change="
                                        setNumericLimit(
                                            'maxOutputChars',
                                            ($event.target as HTMLInputElement).value
                                        )
                                    "
                                />
                            </div>
                        </div>
                    </section>
                </template>

                <section v-else class="space-y-4" data-testid="settings-app-use-logs">
                    <div class="flex flex-wrap gap-2 px-1">
                        <button
                            v-for="tool in appUseTools"
                            :key="tool.tool_id"
                            type="button"
                            :data-testid="`settings-app-use-log-tool-${tool.tool_id}`"
                            :class="[
                                'rounded-[10px] px-3 py-1.5 text-sm transition-colors',
                                selectedLogTool?.tool_id === tool.tool_id
                                    ? 'bg-[#e9e9e7] text-neutral-950'
                                    : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                            ]"
                            @click="
                                selectedLogToolId =
                                    tool.tool_id as (typeof APP_USE_TOOL_IDS)[number]
                            "
                        >
                            {{ tool.display_name }}
                        </button>
                    </div>

                    <BuiltInToolLogViewer v-if="selectedLogTool" :tool="selectedLogTool" />
                </section>
            </template>
        </div>
    </div>
</template>
