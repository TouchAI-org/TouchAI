<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import { open } from '@tauri-apps/plugin-dialog';
    import { storeToRefs } from 'pinia';
    import { computed, onBeforeUnmount, ref, watch } from 'vue';

    import {
        type BrowserFingerprintProfile,
        type BrowserPermissionMode,
        type BrowserPermissionProfile,
        type BrowserSettingsConfig,
        getDefaultHomepageError,
        parseBrowserSettingsConfig,
        serializeBrowserSettingsConfig,
        type ScreenshotAttachmentMode,
    } from '@/config/browserSettings';
    import { type MessageKey, t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';

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
    const canSave = computed(() => !homepageError.value && saveState.value !== 'saving');

    watch(
        () => settings.value.browserSettings,
        (config) => {
            isSyncingFromStore = true;
            draft.value = cloneConfig(config);
            queueMicrotask(() => {
                isSyncingFromStore = false;
            });
        },
        { deep: true }
    );

    function cloneConfig(config: BrowserSettingsConfig): BrowserSettingsConfig {
        return parseBrowserSettingsConfig(serializeBrowserSettingsConfig(config));
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
        source.value = '';
        if (kind === 'allowed') {
            addingAllowedDomain.value = false;
        } else {
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

    onBeforeUnmount(() => {
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
                defaultPath: draft.value.browserDataPath.trim() || undefined,
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
                filters: [{ name: 'Browser executable', extensions: ['exe', 'app'] }],
                title: t('settings.browser.executablePath.pick'),
            });
            if (typeof picked === 'string') {
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
                <div class="min-w-0 max-w-2xl">
                    <h1 class="settings-page-title" data-testid="browser-settings-title">
                        {{ t('settings.nav.browser.label') }}
                    </h1>
                    <p class="settings-section-description">
                        {{ t('settings.browser.description') }}
                    </p>
                </div>
                <button
                    type="button"
                    data-testid="browser-enabled-toggle"
                    :aria-pressed="draft.enabled"
                    :class="[
                        'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                        draft.enabled ? 'settings-toggle-enabled' : 'bg-neutral-200',
                    ]"
                    @click="draft.enabled = !draft.enabled"
                >
                    <span
                        :class="[
                            'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                            draft.enabled ? 'translate-x-[18px]' : 'translate-x-1',
                        ]"
                    />
                </button>
            </header>

            <fieldset :disabled="!draft.enabled" class="contents">
                <section class="space-y-4">
                    <h2 class="settings-section-title">{{ t('settings.browser.section.data') }}</h2>
                <div class="settings-row-group divide-y divide-neutral-200/70">
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                    >
                        <div>
                            <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                {{ t('settings.browser.browserDataPath') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.browser.browserDataPath.description') }}
                            </div>
                        </div>
                        <div class="flex min-w-0 items-center gap-2">
                            <input
                                v-model="draft.browserDataPath"
                                data-testid="browser-data-path-input"
                                class="settings-input min-w-0 flex-1 disabled:bg-neutral-50"
                                placeholder="D:\TouchAI\BrowserData"
                                :disabled="!draft.enabled"
                            />
                            <button
                                type="button"
                                class="settings-icon-button shrink-0"
                                :disabled="!draft.enabled"
                                :title="t('settings.browser.browserDataPath.pick')"
                                @click="pickBrowserDataPath"
                            >
                                <AppIcon name="folder-open" class="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                    >
                        <div>
                            <label class="text-[13px] leading-6 font-normal text-neutral-900">
                                {{ t('settings.browser.executablePath') }}
                            </label>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.browser.executablePath.description') }}
                            </div>
                        </div>
                        <div class="flex min-w-0 items-center gap-2">
                            <input
                                v-model="draft.browserExecutablePath"
                                data-testid="browser-executable-path-input"
                                class="settings-input min-w-0 flex-1 disabled:bg-neutral-50"
                                placeholder="C:\Program Files\Google\Chrome\Application\chrome.exe"
                                :disabled="!draft.enabled"
                            />
                            <button
                                type="button"
                                class="settings-icon-button shrink-0"
                                :disabled="!draft.enabled"
                                :title="t('settings.browser.executablePath.pick')"
                                @click="pickBrowserExecutable"
                            >
                                <AppIcon name="folder" class="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                    >
                        <div>
                            <label class="text-[13px] leading-6 font-normal text-neutral-900">
                                {{ t('settings.browser.defaultHomepage') }}
                            </label>
                            <div
                                class="mt-1 text-xs"
                                :class="homepageError ? 'text-red-500' : 'text-neutral-500'"
                            >
                                {{ homepageError || t('settings.browser.defaultHomepage.description') }}
                            </div>
                        </div>
                        <input
                            v-model="draft.defaultHomepage"
                            data-testid="browser-default-homepage-input"
                            class="settings-input w-full disabled:bg-neutral-50"
                            :class="homepageError ? 'border-red-300 bg-red-50 text-red-600' : ''"
                            placeholder="https://touch-ai.org"
                            :disabled="!draft.enabled"
                        />
                    </div>

                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                    >
                        <div>
                            <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                {{ t('settings.browser.screenshotAttachment') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.browser.screenshotAttachment.description') }}
                            </div>
                        </div>
                        <CustomSelect
                            v-model="draft.screenshotAttachmentMode"
                            :options="screenshotOptions"
                            :disabled="!draft.enabled"
                        />
                    </div>
                </div>
            </section>

            <section class="mt-10 space-y-4">
                <h2 class="settings-section-title">{{ t('settings.browser.section.permissions') }}</h2>
                <div class="settings-row-group divide-y divide-neutral-200/70">
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center"
                    >
                        <div>
                            <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                {{ t('settings.browser.permissionMode') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.browser.permissionMode.description') }}
                            </div>
                        </div>
                        <CustomSelect
                            v-model="draft.permissionMode"
                            :options="permissionModeOptions"
                            :disabled="!draft.enabled"
                        />
                    </div>
                    <template v-if="draft.permissionMode === 'auto'">
                        <div
                            v-for="row in permissionRows"
                            :key="row.key"
                            class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center"
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
                                v-model="draft.permissions[row.key]"
                                :options="permissionOptions"
                                :disabled="!draft.enabled"
                            />
                        </div>
                    </template>
                </div>
            </section>

            <section class="mt-10 space-y-10">
                <div>
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
                    <div v-if="addingBlockedDomain" class="mb-2 flex gap-2">
                        <input
                            v-model="blockedDomainDraft"
                            :disabled="!draft.enabled"
                            class="settings-input flex-1 disabled:bg-neutral-50"
                            placeholder="example.com"
                            spellcheck="false"
                            @keydown.enter.prevent="addDomain('blocked')"
                        />
                        <button
                            type="button"
                            class="settings-button-secondary shrink-0"
                            :disabled="!draft.enabled"
                            @click="addDomain('blocked')"
                        >
                            {{ t('settings.browser.addDomain') }}
                        </button>
                    </div>
                    <div v-if="draft.blockedDomains.length > 0" class="space-y-2">
                        <div
                            v-for="rule in draft.blockedDomains"
                            :key="rule.domain"
                            class="flex gap-2"
                        >
                            <input
                                :value="rule.domain"
                                :disabled="!draft.enabled"
                                readonly
                                type="text"
                                spellcheck="false"
                                class="settings-input flex-1 px-4 py-2.5 font-mono disabled:bg-neutral-50"
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
                    <div
                        v-else
                        class="rounded-lg border border-dashed border-neutral-200 bg-neutral-50/60 px-4 py-3 text-sm text-neutral-500"
                    >
                        {{ t('settings.browser.blockedDomains.empty') }}
                    </div>
                </div>

                <div>
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
                    <div v-if="addingAllowedDomain" class="mb-2 flex gap-2">
                        <input
                            v-model="allowedDomainDraft"
                            :disabled="!draft.enabled"
                            class="settings-input flex-1 disabled:bg-neutral-50"
                            placeholder="github.com"
                            spellcheck="false"
                            @keydown.enter.prevent="addDomain('allowed')"
                        />
                        <button
                            type="button"
                            class="settings-button-secondary shrink-0"
                            :disabled="!draft.enabled"
                            @click="addDomain('allowed')"
                        >
                            {{ t('settings.browser.addDomain') }}
                        </button>
                    </div>
                    <div v-if="draft.allowedDomains.length > 0" class="space-y-2">
                        <div
                            v-for="rule in draft.allowedDomains"
                            :key="rule.domain"
                            class="flex gap-2"
                        >
                            <input
                                :value="rule.domain"
                                :disabled="!draft.enabled"
                                readonly
                                type="text"
                                spellcheck="false"
                                class="settings-input flex-1 px-4 py-2.5 font-mono disabled:bg-neutral-50"
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
                    <div
                        v-else
                        class="rounded-lg border border-dashed border-neutral-200 bg-neutral-50/60 px-4 py-3 text-sm text-neutral-500"
                    >
                        {{ t('settings.browser.allowedDomains.empty') }}
                    </div>
                </div>
            </section>

            <section class="mt-10 space-y-4">
                <h2 class="settings-section-title">{{ t('settings.browser.section.advanced') }}</h2>
                <div class="settings-row-group divide-y divide-neutral-200/70">
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center"
                    >
                        <div>
                            <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                {{ t('settings.browser.fingerprintProfile') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.browser.fingerprintProfile.description') }}
                            </div>
                        </div>
                        <CustomSelect
                            v-model="draft.fingerprintProfile"
                            :options="fingerprintOptions"
                            :disabled="!draft.enabled"
                        />
                    </div>
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                    >
                        <div>
                            <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                {{ t('settings.browser.localeTimezone') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.browser.localeTimezone.description') }}
                            </div>
                        </div>
                        <div class="grid min-w-0 grid-cols-2 gap-2">
                            <input
                                v-model="draft.fingerprintLocale"
                                class="settings-input min-w-0 disabled:bg-neutral-50"
                                placeholder="zh-CN"
                                :disabled="!draft.enabled"
                            />
                            <input
                                v-model="draft.fingerprintTimezone"
                                class="settings-input min-w-0 disabled:bg-neutral-50"
                                placeholder="Asia/Shanghai"
                                :disabled="!draft.enabled"
                            />
                        </div>
                    </div>
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                    >
                        <div>
                            <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                User-Agent
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.browser.userAgent.description') }}
                            </div>
                        </div>
                        <input
                            v-model="draft.fingerprintUserAgent"
                            class="settings-input w-full disabled:bg-neutral-50"
                            placeholder="Mozilla/5.0 ..."
                            :disabled="!draft.enabled"
                        />
                    </div>
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:items-center"
                    >
                        <div>
                            <div class="text-[13px] leading-6 font-normal text-neutral-900">
                                {{ t('settings.browser.windowSize') }}
                            </div>
                            <div class="mt-1 text-xs text-neutral-500">
                                {{ t('settings.browser.windowSize.description') }}
                            </div>
                        </div>
                        <input
                            v-model="draft.fingerprintWindowSize"
                            class="settings-input w-full disabled:bg-neutral-50"
                            placeholder="1366,768"
                            :disabled="!draft.enabled"
                        />
                    </div>
                </div>
            </section>
            </fieldset>
        </div>
    </div>
</template>
