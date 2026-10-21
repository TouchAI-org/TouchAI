<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import EmptyState from '@components/EmptyState.vue';
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { open } from '@tauri-apps/plugin-dialog';
    import { storeToRefs } from 'pinia';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import { native } from '@/services/NativeService';
    import type { BrowserInstalledBrowser } from '@/services/NativeService/types';
    import {
        type BrowserFingerprintProfile,
        type BrowserPermissionMode,
        type BrowserPermissionProfile,
        type BrowserSettingsConfig,
        DEFAULT_BROWSER_SETTINGS,
        getDefaultHomepageError,
        parseBrowserSettingsConfig,
        type ScreenshotAttachmentMode,
        serializeBrowserSettingsConfig,
    } from '@/stores/setting/sections/browser';
    import { useSettingsStore } from '@/stores/settings';

    import DomainRuleInput from './components/DomainRuleInput.vue';
    import { loadCachedDefaultBrowserDataPath, loadCachedInstalledBrowsers } from './runtimeCache';

    defineOptions({ name: 'SettingsBrowserSection' });

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);
    const draft = ref<BrowserSettingsConfig>(cloneConfig(settings.value.browserSettings));
    const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let isSyncingFromStore = false;
    const allowedDomainDraft = ref('');
    const blockedDomainDraft = ref('');
    const addingAllowedDomain = ref(false);
    const addingBlockedDomain = ref(false);
    const isEditingCustomBrowserExecutable = ref(false);
    const installedBrowsers = ref<BrowserInstalledBrowser[]>([]);
    const browserDiscoveryError = ref<string | null>(null);
    const defaultBrowserDataPath = ref('');
    const isDiscoveringInstalledBrowsers = ref(false);
    let isUnmounted = false;

    const DEFAULT_BROWSER_VALUE = 'default';
    const CUSTOM_BROWSER_VALUE = 'custom';

    const permissionOptions = computed<Array<{ value: BrowserPermissionMode; label: string }>>(
        () => [
            { value: 'ask', label: t('settings.browser.permission.ask') },
            { value: 'allow', label: t('settings.browser.permission.allow') },
            { value: 'deny', label: t('settings.browser.permission.deny') },
        ]
    );
    const permissionModeOptions = computed<
        Array<{ value: BrowserPermissionProfile; label: string }>
    >(() => [
        { value: 'allow', label: t('settings.browser.permissionMode.allow') },
        { value: 'auto', label: t('settings.browser.permissionMode.auto') },
        { value: 'deny', label: t('settings.browser.permissionMode.deny') },
    ]);
    const existingSessionOptions = computed<
        Array<{ value: BrowserSettingsConfig['existingSessionPolicy']; label: string }>
    >(() => [
        { value: 'auto', label: t('settings.browser.existingSessionPolicy.auto') },
        { value: 'ask', label: t('settings.browser.existingSessionPolicy.ask') },
        { value: 'deny', label: t('settings.browser.existingSessionPolicy.deny') },
    ]);

    const screenshotOptions = computed<Array<{ value: ScreenshotAttachmentMode; label: string }>>(
        () => [
            { value: 'ask', label: t('settings.browser.screenshot.ask') },
            { value: 'always', label: t('settings.browser.screenshot.always') },
            { value: 'never', label: t('settings.browser.screenshot.never') },
        ]
    );
    const fingerprintOptions = computed<Array<{ value: BrowserFingerprintProfile; label: string }>>(
        () => [
            { value: 'off', label: t('settings.browser.fingerprint.off') },
            { value: 'basic', label: t('settings.browser.fingerprint.basic') },
            { value: 'enhanced', label: t('settings.browser.fingerprint.enhanced') },
        ]
    );
    const defaultModeOptions = computed<Array<{ value: 'visible' | 'headless'; label: string }>>(
        () => [
            { value: 'visible', label: t('settings.browser.defaultMode.visible') },
            { value: 'headless', label: t('settings.browser.defaultMode.headless') },
        ]
    );

    const permissionRowDefinitions: Array<{
        key: keyof BrowserSettingsConfig['permissions'];
        labelKey: MessageKey;
        descriptionKey: MessageKey;
    }> = [
        {
            key: 'navigate',
            labelKey: 'settings.browser.permission.navigate',
            descriptionKey: 'settings.browser.permission.navigate.description',
        },
        {
            key: 'connectExisting',
            labelKey: 'settings.browser.permission.connectExisting',
            descriptionKey: 'settings.browser.permission.connectExisting.description',
        },
        {
            key: 'observeDom',
            labelKey: 'settings.browser.permission.observeDom',
            descriptionKey: 'settings.browser.permission.observeDom.description',
        },
        {
            key: 'screenshot',
            labelKey: 'settings.browser.permission.screenshot',
            descriptionKey: 'settings.browser.permission.screenshot.description',
        },
        {
            key: 'click',
            labelKey: 'settings.browser.permission.click',
            descriptionKey: 'settings.browser.permission.click.description',
        },
        {
            key: 'type',
            labelKey: 'settings.browser.permission.type',
            descriptionKey: 'settings.browser.permission.type.description',
        },
        {
            key: 'fillForm',
            labelKey: 'settings.browser.permission.fillForm',
            descriptionKey: 'settings.browser.permission.fillForm.description',
        },
        {
            key: 'history',
            labelKey: 'settings.browser.permission.history',
            descriptionKey: 'settings.browser.permission.history.description',
        },
        {
            key: 'diagnostics',
            labelKey: 'settings.browser.permission.diagnostics',
            descriptionKey: 'settings.browser.permission.diagnostics.description',
        },
    ];

    const permissionRows = computed(() =>
        permissionRowDefinitions.map((row) => ({
            key: row.key,
            label: t(row.labelKey),
            description: t(row.descriptionKey),
        }))
    );

    const homepageError = computed(() => getDefaultHomepageError(draft.value));
    const homepageErrorText = computed(() => (homepageError.value ? t(homepageError.value) : null));
    const canSave = computed(() => !homepageError.value && saveState.value !== 'saving');
    const defaultHomepageValue = computed({
        get() {
            return draft.value.defaultHomepage.trim() || DEFAULT_BROWSER_SETTINGS.defaultHomepage;
        },
        set(value: string) {
            draft.value.defaultHomepage = value;
        },
    });
    const browserDataPathValue = computed({
        get() {
            return draft.value.browserDataPath.trim() || defaultBrowserDataPath.value;
        },
        set(value: string) {
            draft.value.browserDataPath = value;
        },
    });
    const discoveredBrowserPaths = computed(
        () => new Set(installedBrowsers.value.map((browser) => browser.path))
    );
    const browserExecutableMode = computed({
        get() {
            if (isEditingCustomBrowserExecutable.value) {
                return CUSTOM_BROWSER_VALUE;
            }
            const configuredPath = draft.value.browserExecutablePath.trim();
            if (configuredPath) {
                return discoveredBrowserPaths.value.has(configuredPath)
                    ? configuredPath
                    : CUSTOM_BROWSER_VALUE;
            }
            return DEFAULT_BROWSER_VALUE;
        },
        set(value: string) {
            if (value === DEFAULT_BROWSER_VALUE) {
                isEditingCustomBrowserExecutable.value = false;
                draft.value.browserExecutablePath = '';
                return;
            }
            if (value === CUSTOM_BROWSER_VALUE) {
                isEditingCustomBrowserExecutable.value = true;
                if (discoveredBrowserPaths.value.has(draft.value.browserExecutablePath.trim())) {
                    draft.value.browserExecutablePath = '';
                }
                return;
            }
            isEditingCustomBrowserExecutable.value = false;
            draft.value.browserExecutablePath = value;
        },
    });
    const defaultBrowserDescription = computed(() => {
        const browser = installedBrowsers.value[0];
        if (!browser) return undefined;
        return t('settings.browser.executablePath.default.description', {
            browser: browser.name,
        });
    });
    const browserExecutableOptions = computed(() => [
        {
            value: DEFAULT_BROWSER_VALUE,
            label: t('settings.browser.executablePath.default'),
            description: defaultBrowserDescription.value,
        },
        ...installedBrowsers.value.map((browser) => ({
            value: browser.path,
            label: browser.name,
            description: browser.path,
        })),
        {
            value: CUSTOM_BROWSER_VALUE,
            label: t('settings.browser.executablePath.custom'),
        },
    ]);
    const isCustomBrowserExecutable = computed(
        () => browserExecutableMode.value === CUSTOM_BROWSER_VALUE
    );
    const selectedDefaultMode = computed({
        get() {
            return draft.value.headless ? 'headless' : 'visible';
        },
        set(value: 'visible' | 'headless') {
            draft.value.headless = value === 'headless';
        },
    });
    const fingerprintWindowWidth = computed({
        get() {
            return draft.value.fingerprintWindowSize.split(',')[0] ?? '';
        },
        set(value: string) {
            const [, height = ''] = draft.value.fingerprintWindowSize.split(',');
            draft.value.fingerprintWindowSize = `${value.trim()},${height.trim()}`;
        },
    });
    const fingerprintWindowHeight = computed({
        get() {
            return draft.value.fingerprintWindowSize.split(',')[1] ?? '';
        },
        set(value: string) {
            const [width = ''] = draft.value.fingerprintWindowSize.split(',');
            draft.value.fingerprintWindowSize = `${width.trim()},${value.trim()}`;
        },
    });

    watch(
        () => settings.value.browserSettings,
        (config) => {
            isSyncingFromStore = true;
            draft.value = cloneConfig(config);
            isEditingCustomBrowserExecutable.value = Boolean(
                draft.value.browserExecutablePath.trim() &&
                !discoveredBrowserPaths.value.has(draft.value.browserExecutablePath.trim())
            );
            queueMicrotask(() => {
                isSyncingFromStore = false;
            });
        },
        { deep: true }
    );

    function cloneConfig(config: BrowserSettingsConfig): BrowserSettingsConfig {
        return parseBrowserSettingsConfig(serializeBrowserSettingsConfig(config));
    }

    async function loadInstalledBrowsers(options: { force?: boolean } = {}) {
        const preserveCurrentBrowsers = installedBrowsers.value.length > 0;
        isDiscoveringInstalledBrowsers.value = true;
        try {
            browserDiscoveryError.value = null;
            const browsers = await loadCachedInstalledBrowsers(
                () => native.browser.discoverInstalled(),
                options
            );
            if (isUnmounted) {
                return;
            }
            installedBrowsers.value = browsers;
            const configuredPath = draft.value.browserExecutablePath.trim();
            isEditingCustomBrowserExecutable.value = Boolean(
                configuredPath && !discoveredBrowserPaths.value.has(configuredPath)
            );
        } catch (error) {
            if (isUnmounted) {
                return;
            }
            browserDiscoveryError.value = error instanceof Error ? error.message : String(error);
            if (!preserveCurrentBrowsers) {
                installedBrowsers.value = [];
            }
        } finally {
            if (!isUnmounted) {
                isDiscoveringInstalledBrowsers.value = false;
            }
        }
    }

    async function loadDefaultBrowserDataPath() {
        try {
            const path = await loadCachedDefaultBrowserDataPath(() =>
                native.browser.defaultDataPath()
            );
            if (isUnmounted) {
                return;
            }
            defaultBrowserDataPath.value = path;
        } catch (error) {
            if (isUnmounted) {
                return;
            }
            console.error('[BrowserSettings] Failed to load default browser data path:', error);
            defaultBrowserDataPath.value = '';
        }
    }

    function handleBrowserExecutableDropdownOpen(open: boolean) {
        if (!open || isDiscoveringInstalledBrowsers.value) {
            return;
        }

        void loadInstalledBrowsers({ force: true });
    }

    function normalizeDomain(value: string): string {
        return value.trim().toLowerCase();
    }

    function addDomain(kind: 'allowed' | 'blocked') {
        const source = kind === 'allowed' ? allowedDomainDraft : blockedDomainDraft;
        const domain = normalizeDomain(source.value);
        if (!domain) return;

        const key = kind === 'allowed' ? 'allowedDomains' : 'blockedDomains';
        if (!draft.value[key].some((rule) => rule.domain === domain)) {
            draft.value[key] = [...draft.value[key], { domain }];
        }
        cancelAddingDomain(kind);
    }

    function cancelAddingDomain(kind: 'allowed' | 'blocked') {
        if (kind === 'allowed') {
            allowedDomainDraft.value = '';
            addingAllowedDomain.value = false;
        } else {
            blockedDomainDraft.value = '';
            addingBlockedDomain.value = false;
        }
    }

    function removeDomain(kind: 'allowed' | 'blocked', domain: string) {
        const key = kind === 'allowed' ? 'allowedDomains' : 'blockedDomains';
        draft.value[key] = draft.value[key].filter((rule) => rule.domain !== domain);
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

    watch(draft, scheduleAutoSave, { deep: true });

    onMounted(() => {
        void loadInstalledBrowsers();
        void loadDefaultBrowserDataPath();
    });

    onBeforeUnmount(() => {
        isUnmounted = true;
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
    });

    async function pickBrowserDataPath() {
        try {
            const picked = await open({
                directory: true,
                multiple: false,
                defaultPath:
                    draft.value.browserDataPath.trim() || defaultBrowserDataPath.value || undefined,
                title: t('settings.browser.browserDataPath.pick'),
            });
            if (typeof picked === 'string') {
                draft.value.browserDataPath = picked;
            }
        } catch (error) {
            console.error('[BrowserSettings] Failed to pick browser data path:', error);
        }
    }

    async function pickBrowserExecutable() {
        try {
            const picked = await open({
                directory: false,
                multiple: false,
                defaultPath: draft.value.browserExecutablePath.trim() || undefined,
                title: t('settings.browser.executablePath.pick'),
            });
            if (typeof picked === 'string') {
                isEditingCustomBrowserExecutable.value = true;
                draft.value.browserExecutablePath = picked;
            }
        } catch (error) {
            console.error('[BrowserSettings] Failed to pick browser executable:', error);
        }
    }

    async function saveSettings() {
        if (!canSave.value) return;
        saveState.value = 'saving';
        try {
            await settingsStore.updateBrowserSettings({ ...draft.value });
            saveState.value = 'saved';
            isSyncingFromStore = true;
            queueMicrotask(() => {
                isSyncingFromStore = false;
            });
        } catch (error) {
            console.error('[BrowserSettings] Failed to save browser settings:', error);
            saveState.value = 'error';
        }
    }
</script>

<template>
    <div class="settings-page" data-testid="settings-browser-section">
        <div class="settings-section-stack">
            <header class="settings-page-header flex items-start gap-4">
                <div class="max-w-2xl min-w-0">
                    <h1 class="settings-page-title" data-testid="browser-settings-title">
                        {{ t('settings.nav.browser.label') }}
                    </h1>
                    <p class="settings-section-description">
                        {{ t('settings.browser.description') }}
                    </p>
                </div>
                <Switch
                    size="lg"
                    class="ml-auto shrink-0"
                    data-testid="browser-enabled-toggle"
                    :model-value="draft.enabled"
                    @update:model-value="draft.enabled = !draft.enabled"
                />
            </header>

            <fieldset :disabled="!draft.enabled" class="contents">
                <section class="space-y-4">
                    <h2 class="settings-section-title">{{ t('settings.browser.section.data') }}</h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <SettingsRow
                            data-settings-search-target="browser-data-path"
                            control-width="320"
                            :label="t('settings.browser.browserDataPath')"
                            :description="t('settings.browser.browserDataPath.description')"
                            control-class="flex items-center gap-2"
                        >
                            <Input
                                v-model="browserDataPathValue"
                                variant="filled"
                                data-testid="browser-data-path-input"
                                class="min-w-0 flex-1 disabled:bg-neutral-50"
                                placeholder="browser-data"
                                :disabled="!draft.enabled"
                            />
                            <Button
                                variant="ghost-neutral"
                                class="shrink-0"
                                :disabled="!draft.enabled"
                                :title="t('settings.browser.browserDataPath.pick')"
                                @click="pickBrowserDataPath"
                            >
                                <AppIcon name="folder-open" class="h-4 w-4" />
                            </Button>
                        </SettingsRow>

                        <SettingsRow
                            data-settings-search-target="browser-executable"
                            control-width="320"
                            label-as="label"
                            :label="t('settings.browser.executablePath')"
                            control-class="space-y-2"
                        >
                            <template #description>
                                <div class="mt-1 text-xs text-neutral-500">
                                    {{
                                        browserDiscoveryError ||
                                        t('settings.browser.executablePath.description')
                                    }}
                                </div>
                            </template>
                            <CustomSelect
                                v-model="browserExecutableMode"
                                data-testid="browser-executable-select"
                                :options="browserExecutableOptions"
                                :disabled="!draft.enabled"
                                @update:open="handleBrowserExecutableDropdownOpen"
                            />
                        </SettingsRow>

                        <SettingsRow
                            v-if="isCustomBrowserExecutable"
                            control-width="320"
                            label-as="label"
                            :label="t('settings.browser.executablePath.custom')"
                            :description="t('settings.browser.executablePath.custom.description')"
                            control-class="flex items-center gap-2"
                        >
                            <Input
                                v-model="draft.browserExecutablePath"
                                variant="filled"
                                data-testid="browser-executable-path-input"
                                class="min-w-0 flex-1 disabled:bg-neutral-50"
                                placeholder="C:\Program Files\Google\Chrome\Application\chrome.exe"
                                :disabled="!draft.enabled"
                            />
                            <Button
                                variant="ghost-neutral"
                                class="shrink-0"
                                :disabled="!draft.enabled"
                                :title="t('settings.browser.executablePath.pick')"
                                @click="pickBrowserExecutable"
                            >
                                <AppIcon name="folder" class="h-4 w-4" />
                            </Button>
                        </SettingsRow>

                        <SettingsRow
                            data-settings-search-target="browser-homepage"
                            control-width="320"
                            label-as="label"
                            :label="t('settings.browser.defaultHomepage')"
                        >
                            <template #description>
                                <div
                                    class="mt-1 text-xs"
                                    :class="homepageError ? 'text-red-500' : 'text-neutral-500'"
                                >
                                    {{
                                        homepageErrorText ||
                                        t('settings.browser.defaultHomepage.description')
                                    }}
                                </div>
                            </template>
                            <Input
                                v-model="defaultHomepageValue"
                                variant="filled"
                                data-testid="browser-default-homepage-input"
                                class="w-full disabled:bg-neutral-50"
                                :class="
                                    homepageError ? 'border-red-300 bg-red-50 text-red-600' : ''
                                "
                                placeholder="https://touch-ai.org"
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>

                        <SettingsRow
                            data-settings-search-target="browser-mode"
                            control-width="320"
                            :label="t('settings.browser.defaultMode')"
                            :description="t('settings.browser.defaultMode.description')"
                        >
                            <CustomSelect
                                v-model="selectedDefaultMode"
                                data-testid="browser-default-mode-select"
                                :options="defaultModeOptions"
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>

                        <SettingsRow
                            data-settings-search-target="browser-screenshot"
                            control-width="320"
                            :label="t('settings.browser.screenshotAttachment')"
                            :description="t('settings.browser.screenshotAttachment.description')"
                        >
                            <CustomSelect
                                v-model="draft.screenshotAttachmentMode"
                                :options="screenshotOptions"
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>
                    </div>
                </section>

                <section class="mt-10 space-y-4">
                    <h2 class="settings-section-title">
                        {{ t('settings.browser.section.permissions') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <SettingsRow
                            data-settings-search-target="browser-permission-mode"
                            control-width="220"
                            :label="t('settings.browser.permissionMode')"
                            :description="t('settings.browser.permissionMode.description')"
                        >
                            <CustomSelect
                                v-model="draft.permissionMode"
                                data-testid="browser-permission-mode-select"
                                :options="permissionModeOptions"
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="browser-existing-session"
                            control-width="220"
                            :label="t('settings.browser.existingSessionPolicy')"
                            :description="t('settings.browser.existingSessionPolicy.description')"
                        >
                            <CustomSelect
                                v-model="draft.existingSessionPolicy"
                                data-testid="browser-existing-session-policy-select"
                                :options="existingSessionOptions"
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>
                        <template v-if="draft.permissionMode === 'auto'">
                            <SettingsRow
                                v-for="row in permissionRows"
                                :key="row.key"
                                :data-settings-search-target="`browser-permission-${row.key}`"
                                control-width="220"
                                :label="row.label"
                                :description="row.description"
                            >
                                <CustomSelect
                                    v-model="draft.permissions[row.key]"
                                    :options="permissionOptions"
                                    :disabled="!draft.enabled"
                                />
                            </SettingsRow>
                        </template>
                    </div>
                </section>

                <section class="mt-10 space-y-10">
                    <div data-settings-search-target="browser-blocked-domains">
                        <div class="mb-2 flex items-center justify-between">
                            <h2 class="settings-section-title">
                                {{ t('settings.browser.blockedDomains') }}
                            </h2>
                            <button
                                type="button"
                                class="text-neutral-400 transition-colors hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
                                :disabled="!draft.enabled"
                                @click="draft.enabled && (addingBlockedDomain = true)"
                            >
                                <AppIcon name="plus" class="h-5 w-5" />
                            </button>
                        </div>
                        <DomainRuleInput
                            v-if="addingBlockedDomain"
                            v-model="blockedDomainDraft"
                            class="mb-2"
                            :disabled="!draft.enabled"
                            :label="t('settings.browser.blockedDomains')"
                            placeholder="example.com"
                            @submit="addDomain('blocked')"
                            @cancel="cancelAddingDomain('blocked')"
                        />
                        <div v-if="draft.blockedDomains.length > 0" class="space-y-2">
                            <div
                                v-for="rule in draft.blockedDomains"
                                :key="rule.domain"
                                class="flex gap-2"
                            >
                                <Input
                                    variant="filled"
                                    :model-value="rule.domain"
                                    :disabled="!draft.enabled"
                                    readonly
                                    type="text"
                                    spellcheck="false"
                                    class="flex-1 px-4 py-2.5 font-mono disabled:bg-neutral-50"
                                />
                                <button
                                    type="button"
                                    class="text-neutral-400 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                                    :disabled="!draft.enabled"
                                    @click="removeDomain('blocked', rule.domain)"
                                >
                                    <AppIcon name="x" class="h-5 w-5" />
                                </button>
                            </div>
                        </div>
                        <EmptyState
                            v-else-if="!addingBlockedDomain"
                            :title="t('settings.browser.blockedDomains.emptyTitle')"
                            :description="t('settings.browser.blockedDomains.empty')"
                        >
                            <template v-if="draft.enabled" #actions>
                                <Button
                                    variant="outline-neutral"
                                    @click="addingBlockedDomain = true"
                                >
                                    {{ t('settings.browser.addDomainButton') }}
                                </Button>
                            </template>
                        </EmptyState>
                    </div>

                    <div data-settings-search-target="browser-allowed-domains">
                        <div class="mb-2 flex items-center justify-between">
                            <h2 class="settings-section-title">
                                {{ t('settings.browser.allowedDomains') }}
                            </h2>
                            <button
                                type="button"
                                class="text-neutral-400 transition-colors hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
                                :disabled="!draft.enabled"
                                @click="draft.enabled && (addingAllowedDomain = true)"
                            >
                                <AppIcon name="plus" class="h-5 w-5" />
                            </button>
                        </div>
                        <DomainRuleInput
                            v-if="addingAllowedDomain"
                            v-model="allowedDomainDraft"
                            class="mb-2"
                            :disabled="!draft.enabled"
                            :label="t('settings.browser.allowedDomains')"
                            placeholder="github.com"
                            @submit="addDomain('allowed')"
                            @cancel="cancelAddingDomain('allowed')"
                        />
                        <div v-if="draft.allowedDomains.length > 0" class="space-y-2">
                            <div
                                v-for="rule in draft.allowedDomains"
                                :key="rule.domain"
                                class="flex gap-2"
                            >
                                <Input
                                    variant="filled"
                                    :model-value="rule.domain"
                                    :disabled="!draft.enabled"
                                    readonly
                                    type="text"
                                    spellcheck="false"
                                    class="flex-1 px-4 py-2.5 font-mono disabled:bg-neutral-50"
                                />
                                <button
                                    type="button"
                                    class="text-neutral-400 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                                    :disabled="!draft.enabled"
                                    @click="removeDomain('allowed', rule.domain)"
                                >
                                    <AppIcon name="x" class="h-5 w-5" />
                                </button>
                            </div>
                        </div>
                        <EmptyState
                            v-else-if="!addingAllowedDomain"
                            :title="t('settings.browser.allowedDomains.emptyTitle')"
                            :description="t('settings.browser.allowedDomains.empty')"
                        >
                            <template v-if="draft.enabled" #actions>
                                <Button
                                    variant="outline-neutral"
                                    @click="addingAllowedDomain = true"
                                >
                                    {{ t('settings.browser.addDomainButton') }}
                                </Button>
                            </template>
                        </EmptyState>
                    </div>
                </section>

                <section class="mt-10 space-y-4">
                    <h2 class="settings-section-title">
                        {{ t('settings.browser.section.advanced') }}
                    </h2>
                    <div class="settings-row-group divide-y divide-neutral-200/70">
                        <SettingsRow
                            data-testid="browser-fingerprint-profile-row"
                            data-settings-search-target="browser-fingerprint"
                            control-width="320"
                            :label="t('settings.browser.fingerprintProfile')"
                            :description="t('settings.browser.fingerprintProfile.description')"
                        >
                            <CustomSelect
                                v-model="draft.fingerprintProfile"
                                :options="fingerprintOptions"
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="browser-locale-timezone"
                            control-width="320"
                            :label="t('settings.browser.localeTimezone')"
                            :description="t('settings.browser.localeTimezone.description')"
                            control-class="grid grid-cols-2 gap-2"
                        >
                            <Input
                                v-model="draft.fingerprintLocale"
                                variant="filled"
                                class="min-w-0 disabled:bg-neutral-50"
                                placeholder="zh-CN"
                                :disabled="!draft.enabled"
                            />
                            <Input
                                v-model="draft.fingerprintTimezone"
                                variant="filled"
                                class="min-w-0 disabled:bg-neutral-50"
                                placeholder="Asia/Shanghai"
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="browser-user-agent"
                            control-width="320"
                            :label="t('settings.browser.userAgent')"
                            :description="t('settings.browser.userAgent.description')"
                        >
                            <Input
                                v-model="draft.fingerprintUserAgent"
                                variant="filled"
                                class="w-full disabled:bg-neutral-50"
                                placeholder="Mozilla/5.0 ..."
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>
                        <SettingsRow
                            data-settings-search-target="browser-window-size"
                            control-width="320"
                            :label="t('settings.browser.windowSize')"
                            :description="t('settings.browser.windowSize.description')"
                            control-class="grid grid-cols-2 gap-2"
                        >
                            <Input
                                v-model="fingerprintWindowWidth"
                                variant="filled"
                                data-testid="browser-window-width-input"
                                class="min-w-0 disabled:bg-neutral-50"
                                placeholder="1366"
                                inputmode="numeric"
                                :disabled="!draft.enabled"
                            />
                            <Input
                                v-model="fingerprintWindowHeight"
                                variant="filled"
                                data-testid="browser-window-height-input"
                                class="min-w-0 disabled:bg-neutral-50"
                                placeholder="768"
                                inputmode="numeric"
                                :disabled="!draft.enabled"
                            />
                        </SettingsRow>
                    </div>
                </section>
            </fieldset>
        </div>
    </div>
</template>
