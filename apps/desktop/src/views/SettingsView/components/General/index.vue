<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import {
        AppEvent,
        eventService,
        type ShortcutCaptureSystemKeyEvent,
    } from '@services/EventService';
    import { native } from '@services/NativeService';
    import { notify } from '@services/NotificationService';
    import { type UnlistenFn } from '@tauri-apps/api/event';
    import { storeToRefs } from 'pinia';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import {
        resolveSearchWindowDefaultSize,
        type SearchWindowSizePreset,
    } from '@/config/searchWindow';
    import {
        type AppLocale,
        LOCALE_LABELS,
        type MessageKey,
        type MessageParams,
        SUPPORTED_LOCALES,
        t,
    } from '@/i18n';
    import { type OutputScrollBehavior, useSettingsStore } from '@/stores/settings';
    import {
        captureShortcutFromKeyboardEvent,
        hasCommandModifier,
        isMacPlatform,
        isReservedLocalShortcutKey,
        normalizeLocalShortcutString,
    } from '@/utils/shortcuts';

    import SearchShortcutSettings from './SearchShortcutSettings.vue';
    import { resolveShortcutCaptureCompletion } from './shortcutCapture';
    import UpdateSettingsSection from './UpdateSettingsSection.vue';

    defineOptions({
        name: 'SettingsGeneralSection',
    });

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);

    const outputScrollBehaviorOptions = computed(
        (): Array<{
            value: OutputScrollBehavior;
            label: string;
            description: string;
        }> => [
            {
                value: 'follow_output',
                label: t('settings.general.outputScroll.follow'),
                description: t('settings.general.outputScroll.followDescription'),
            },
            {
                value: 'stay_position',
                label: t('settings.general.outputScroll.stay'),
                description: t('settings.general.outputScroll.stayDescription'),
            },
            {
                value: 'jump_to_top',
                label: t('settings.general.outputScroll.jumpToTop'),
                description: t('settings.general.outputScroll.jumpToTopDescription'),
            },
        ]
    );

    const searchWindowSizeOptions = computed(
        (): Array<{
            value: SearchWindowSizePreset;
            label: string;
        }> => [
            { value: 'small', label: t('settings.general.size.small') },
            { value: 'normal', label: t('settings.general.size.normal') },
            { value: 'large', label: t('settings.general.size.large') },
        ]
    );

    const languageOptions: Array<{
        value: AppLocale;
        label: string;
    }> = SUPPORTED_LOCALES.map((value) => ({
        value,
        label: LOCALE_LABELS[value],
    }));

    const isSaving = ref(false);
    const isCapturing = ref(false);
    const hasCapturedShortcut = ref(false);
    const displayShortcut = ref('');
    const shortcutCapturePrompt = computed(() => t('settings.general.shortcutCapturePrompt'));
    const pendingLanguage = ref<AppLocale>(settings.value.language);
    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const shortcutRegistrationFailed = ref(false);
    const showGlobalShortcutPresetMenu = ref(false);
    // Mac 上 Cmd+Space 被 Spotlight 占用，因此预设使用 Option+Space（Alt+Space）和 Ctrl+Space；
    // Windows/Linux 上 Cmd 由 Win/Super 键代表，前端统一拒绝其作为快捷键，预设保持 Alt/Ctrl 组合。
    const globalShortcutPresetShortcuts = ['Alt+Space', 'Ctrl+Space'] as const;
    const globalShortcutPresetOptions = computed(() =>
        globalShortcutPresetShortcuts.map((shortcut) => ({
            label: shortcut,
            value: shortcut,
        }))
    );

    function findGlobalShortcutSearchConflict(shortcut: string): boolean {
        const normalizedShortcut = normalizeLocalShortcutString(shortcut);
        if (!normalizedShortcut) {
            return false;
        }

        return Object.values(settings.value.searchKeybindings).some((searchShortcut) => {
            const normalizedSearchShortcut = normalizeLocalShortcutString(searchShortcut);
            return normalizedSearchShortcut === normalizedShortcut;
        });
    }

    const captureShortcut = (event: KeyboardEvent) => {
        if (!isCapturing.value) {
            return;
        }

        if (isReservedLocalShortcutKey(event.key, event.code)) {
            return;
        }

        const captured = captureShortcutFromKeyboardEvent(event);
        if (!captured) {
            // captureShortcutFromKeyboardEvent 在非 Mac 上对 metaKey 返回 null，
            // 用以拒绝 Win/Super 键组合。Mac 上 metaKey 是 Cmd，不会返回 null。
            if (!isMacPlatform() && event.metaKey) {
                alertMessage.value?.warning(t('settings.general.winKeyUnsupported'), 3000);
            }
            return;
        }

        if (!hasCommandModifier(captured.shortcut)) {
            alertMessage.value?.warning(
                t('settings.general.searchShortcuts.errors.modifierRequired'),
                3000
            );
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        // 全局快捷键存储平台原文（Mac 上为 Cmd+，其他平台为 Ctrl+），
        // 以便 Rust 侧 parse_shortcut 直接识别。captured.shortcut 使用平台中性的
        // `Mod` 抽象，captured.displayShortcut 才是当前平台的字面形式。
        displayShortcut.value = captured.displayShortcut;
        hasCapturedShortcut.value = true;
        showGlobalShortcutPresetMenu.value = false;
        void confirmCapturedShortcut(captured.displayShortcut);
    };

    /**
     * 处理来自 Rust 端的系统级快捷键桥接事件（如 Alt+Space）。
     *
     * Windows 上 Alt+Space 会被 WebView2 当作 system accelerator 截获，
     * 不会派发 DOM keydown，因此 [`webview_defaults.rs`] 在 accelerator 阶段
     * 直接 emit 此事件，由这里复用与键盘录入相同的保存路径。
     */
    const handleSystemKeyCapture = (payload: ShortcutCaptureSystemKeyEvent) => {
        if (!isCapturing.value) {
            return;
        }

        const modifiers: string[] = [];
        if (payload.ctrl) {
            modifiers.push('Ctrl');
        }
        if (payload.alt) {
            modifiers.push('Alt');
        }
        if (payload.shift) {
            modifiers.push('Shift');
        }

        const shortcut = [...modifiers, payload.key].join('+');
        if (!hasCommandModifier(shortcut)) {
            return;
        }

        displayShortcut.value = shortcut;
        hasCapturedShortcut.value = true;
        showGlobalShortcutPresetMenu.value = false;
        void confirmCapturedShortcut(shortcut);
    };

    let unlistenSystemKey: UnlistenFn | null = null;

    const startCapture = () => {
        isCapturing.value = true;
        hasCapturedShortcut.value = false;
        displayShortcut.value = shortcutCapturePrompt.value;
        showGlobalShortcutPresetMenu.value = true;
    };

    function focusShortcutCaptureInput(event: MouseEvent) {
        event.preventDefault();
        (event.currentTarget as HTMLInputElement).focus();
    }

    function clearShortcutCaptureSelection(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const cursorPosition = input.value.length;
        input.setSelectionRange(cursorPosition, cursorPosition);
    }

    const confirmCapturedShortcut = async (shortcut: string) => {
        if (!isCapturing.value) {
            return;
        }

        isCapturing.value = false;
        showGlobalShortcutPresetMenu.value = false;

        if (shortcut === settings.value.globalShortcut) {
            displayShortcut.value = settings.value.globalShortcut;
            return;
        }

        await saveNewShortcut(shortcut);
    };

    const stopCaptureAndSave = async () => {
        if (!isCapturing.value) {
            return;
        }

        isCapturing.value = false;
        showGlobalShortcutPresetMenu.value = false;

        const completion = resolveShortcutCaptureCompletion({
            currentShortcut: settings.value.globalShortcut,
            displayShortcut: displayShortcut.value,
            hasCapturedShortcut: hasCapturedShortcut.value,
        });

        displayShortcut.value = completion.displayShortcut;
        if (completion.action !== 'save') {
            return;
        }

        await saveNewShortcut(completion.shortcut);
    };

    const handleGlobalShortcutPresetOpenChange = (open: boolean) => {
        if (isSaving.value) {
            return;
        }

        if (open) {
            startCapture();
            return;
        }

        void stopCaptureAndSave();
    };

    const saveNewShortcut = async (newShortcut: string) => {
        if (findGlobalShortcutSearchConflict(newShortcut)) {
            shortcutRegistrationFailed.value = false;
            displayShortcut.value = settings.value.globalShortcut;
            alertMessage.value?.error(
                t('settings.general.searchShortcuts.errors.globalConflict'),
                3000
            );
            return;
        }

        isSaving.value = true;
        shortcutRegistrationFailed.value = false;

        try {
            const registered = await registerShortcut(newShortcut);
            if (!registered) {
                shortcutRegistrationFailed.value = true;
                displayShortcut.value = newShortcut;
                return;
            }

            await saveShortcutToDatabase(newShortcut);
            settings.value.globalShortcut = newShortcut;
            displayShortcut.value = newShortcut;
            alertMessage.value?.success(t('settings.general.shortcutSaved'), 3000);
        } catch (error) {
            console.error('Failed to save shortcut:', error);
            alertMessage.value?.error(t('settings.general.saveShortcutFailed'), 3000);
            displayShortcut.value = settings.value.globalShortcut;
            shortcutRegistrationFailed.value = false;
        } finally {
            isSaving.value = false;
        }
    };

    const useSuggestedShortcut = async (shortcut: string) => {
        if (isSaving.value) {
            return;
        }

        showGlobalShortcutPresetMenu.value = false;
        if (isCapturing.value) {
            isCapturing.value = false;
        }

        await saveNewShortcut(shortcut);
    };

    watch(isCapturing, (newValue) => {
        if (newValue) {
            window.addEventListener('keydown', captureShortcut, { capture: true });
        } else {
            window.removeEventListener('keydown', captureShortcut, { capture: true });
        }
    });

    watch(
        () => settings.value.globalShortcut,
        (shortcut) => {
            if (!isCapturing.value && !shortcutRegistrationFailed.value) {
                displayShortcut.value = shortcut;
            }
        }
    );

    watch(
        () => settings.value.language,
        (language) => {
            pendingLanguage.value = language;
        },
        { immediate: true }
    );

    const loadSettings = async () => {
        try {
            await settingsStore.initialize();
            displayShortcut.value = settings.value.globalShortcut;

            const [failed, error] = await native.shortcut.getShortcutStatus();
            if (failed) {
                shortcutRegistrationFailed.value = true;
                console.warn('[GeneralView] Shortcut registration failed:', error);
            }
        } catch (error) {
            console.error('Failed to load settings:', error);
            alertMessage.value?.error(t('settings.general.loadSettingsFailed'), 3000);
        }
    };

    const registerShortcut = async (shortcut: string): Promise<boolean> => {
        try {
            await native.shortcut.registerGlobalShortcut(shortcut);
            return true;
        } catch (error) {
            console.error('Failed to register shortcut:', error);

            const errorStr = String(error);
            const shortcutErrorMessage: {
                friendlyMessageKey: MessageKey;
                notificationBodyKey: MessageKey;
                params?: MessageParams;
            } = (():
                | {
                      friendlyMessageKey: MessageKey;
                      notificationBodyKey: MessageKey;
                      params: MessageParams;
                  }
                | {
                      friendlyMessageKey: MessageKey;
                      notificationBodyKey: MessageKey;
                      params?: never;
                  } => {
                if (errorStr.includes('already registered') || errorStr.includes('已注册')) {
                    return {
                        friendlyMessageKey:
                            'notification.shortcutRegistrationFailed.alreadyRegistered',
                        notificationBodyKey:
                            'notification.shortcutRegistrationFailed.alreadyRegisteredBody',
                        params: { shortcut },
                    };
                }

                if (errorStr.includes('invalid') || errorStr.includes('无效')) {
                    return {
                        friendlyMessageKey: 'notification.shortcutRegistrationFailed.invalid',
                        notificationBodyKey: 'notification.shortcutRegistrationFailed.invalidBody',
                        params: { shortcut },
                    };
                }

                if (errorStr.includes('Unknown key')) {
                    return {
                        friendlyMessageKey: 'notification.shortcutRegistrationFailed.unsupported',
                        notificationBodyKey:
                            'notification.shortcutRegistrationFailed.unsupportedBody',
                    };
                }

                return {
                    friendlyMessageKey: 'notification.shortcutRegistrationFailed.generic',
                    notificationBodyKey: 'notification.shortcutRegistrationFailed.generic',
                    params: { error: errorStr },
                };
            })();

            notify({
                title: t('notification.shortcutRegistrationFailed.title'),
                body: t(shortcutErrorMessage.notificationBodyKey, shortcutErrorMessage.params),
            });

            alertMessage.value?.error(
                t(shortcutErrorMessage.friendlyMessageKey, shortcutErrorMessage.params),
                4000
            );
            return false;
        }
    };

    const saveShortcutToDatabase = async (shortcut: string) => {
        try {
            await settingsStore.updateGlobalShortcut(shortcut);
        } catch (error) {
            console.error('Failed to save shortcut to database:', error);
            throw error;
        }
    };

    const saveStartOnBoot = async () => {
        try {
            if (settings.value.startOnBoot) {
                await native.autostart.enableAutostart();
            } else {
                await native.autostart.disableAutostart();
            }

            await settingsStore.updateStartOnBoot(settings.value.startOnBoot);
        } catch (error) {
            console.error('Failed to save start_on_boot setting:', error);
            alertMessage.value?.error(t('settings.general.saveStartOnBootFailed'), 3000);
        }
    };

    const saveStartMinimized = async () => {
        try {
            await settingsStore.updateStartMinimized(settings.value.startMinimized);
        } catch (error) {
            console.error('Failed to save start_minimized setting:', error);
            alertMessage.value?.error(t('settings.general.saveSettingsFailed'), 3000);
        }
    };

    const saveOutputScrollBehavior = async () => {
        try {
            await settingsStore.updateOutputScrollBehavior(settings.value.outputScrollBehavior);
            alertMessage.value?.success(t('common.saved'), 2000);
        } catch (error) {
            console.error('Failed to save output_scroll_behavior setting:', error);
            alertMessage.value?.error(t('settings.general.saveSettingsFailed'), 3000);
        }
    };

    const saveSearchWindowSizePreset = async (preset: SearchWindowSizePreset) => {
        try {
            const size = resolveSearchWindowDefaultSize(preset);

            await settingsStore.updateSearchWindowSizePreset(preset);
            await native.window.setSearchWindowDefaults(size);

            alertMessage.value?.success(t('settings.general.searchWindowSizeUpdated'), 2000);
        } catch (error) {
            console.error('Failed to save search window size preset:', error);
            alertMessage.value?.error(t('settings.general.saveSearchWindowSizeFailed'), 3000);
        }
    };

    const saveLanguage = async (language: AppLocale) => {
        try {
            await settingsStore.updateLanguage(language);
            pendingLanguage.value = settings.value.language;
            alertMessage.value?.success(t('common.saved'), 2000);
        } catch (error) {
            console.error('Failed to save language setting:', error);
            alertMessage.value?.error(t('settings.general.saveLanguageFailed'), 3000);
            pendingLanguage.value = settings.value.language;
        }
    };

    onMounted(async () => {
        await loadSettings();

        try {
            unlistenSystemKey = await eventService.on(
                AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY,
                handleSystemKeyCapture
            );
        } catch (error) {
            console.error('Failed to subscribe to system key capture event:', error);
        }

        try {
            const isEnabled = await native.autostart.isAutostartEnabled();
            if (isEnabled !== settings.value.startOnBoot) {
                settings.value.startOnBoot = isEnabled;
                await settingsStore.updateStartOnBoot(isEnabled);
            }
        } catch (error) {
            console.error('Failed to check autostart status:', error);
        }
    });

    onUnmounted(() => {
        window.removeEventListener('keydown', captureShortcut, { capture: true });
        unlistenSystemKey?.();
        unlistenSystemKey = null;
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div class="settings-page" data-testid="settings-general-section">
        <div data-testid="settings-general-layout" class="settings-section-stack">
            <header class="settings-page-header">
                <h1 class="settings-page-title">{{ t('settings.nav.general.label') }}</h1>
            </header>

            <section class="space-y-4">
                <div>
                    <h2 class="settings-section-title">
                        {{ t('settings.general.shortcuts') }}
                    </h2>
                </div>

                <div class="text-[12px] leading-5 font-medium text-neutral-500">
                    {{ t('settings.general.globalShortcutGroup') }}
                </div>

                <div
                    data-testid="settings-general-card-shortcut"
                    class="settings-row-group divide-y divide-neutral-200/70 overflow-visible"
                >
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_360px] sm:items-center"
                    >
                        <label
                            data-testid="settings-general-row-label"
                            class="text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            <div>{{ t('settings.general.activationShortcut') }}</div>
                            <div class="text-[12px] leading-5 text-neutral-500">
                                {{ t('settings.general.activationShortcutDescription') }}
                            </div>
                        </label>
                        <div class="min-w-0 justify-self-end">
                            <div
                                data-testid="settings-shortcut-control-row"
                                class="flex min-w-0 items-center justify-end text-[11px]"
                            >
                                <div data-testid="settings-general-control" class="w-[220px]">
                                    <div
                                        data-testid="settings-general-shortcut-input-wrap"
                                        class="relative ml-auto w-[220px] shrink-0"
                                    >
                                        <CustomSelect
                                            :model-value="displayShortcut"
                                            :options="globalShortcutPresetOptions"
                                            :open="showGlobalShortcutPresetMenu"
                                            :display-label="displayShortcut"
                                            :disabled="isSaving"
                                            trigger-as="div"
                                            content-test-id="settings-global-shortcut-preset-menu"
                                            option-test-id-prefix="settings-global-shortcut-preset-"
                                            disable-portal
                                            protect-option-text
                                            @update:open="handleGlobalShortcutPresetOpenChange"
                                            @update:model-value="useSuggestedShortcut"
                                        >
                                            <template #trigger>
                                                <input
                                                    v-model="displayShortcut"
                                                    data-testid="settings-global-shortcut-input"
                                                    type="text"
                                                    readonly
                                                    class="shortcut-capture-input min-w-0 flex-1 bg-transparent text-center text-[12px] outline-none select-none"
                                                    :disabled="isSaving"
                                                    :placeholder="
                                                        t('settings.general.shortcutPlaceholder')
                                                    "
                                                    @pointerdown.stop
                                                    @mousedown="focusShortcutCaptureInput"
                                                    @select="clearShortcutCaptureSelection"
                                                    @dragstart.prevent
                                                    @keydown.capture="captureShortcut"
                                                    @click.stop
                                                    @focus="startCapture"
                                                />
                                            </template>
                                        </CustomSelect>
                                        <span
                                            v-if="shortcutRegistrationFailed"
                                            data-testid="settings-shortcut-occupied-indicator"
                                            class="absolute top-1/2 right-8 flex h-4 w-4 -translate-y-1/2 items-center justify-center text-red-500"
                                            :title="
                                                t('settings.general.shortcutRegistrationFailed')
                                            "
                                        >
                                            <AppIcon
                                                name="exclamation-triangle"
                                                class="h-3.5 w-3.5"
                                            />
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <SearchShortcutSettings />
            </section>

            <section class="space-y-4">
                <div>
                    <h2 class="settings-section-title">
                        {{ t('settings.general.startupAndWindow') }}
                    </h2>
                    <p class="settings-section-description">
                        {{ t('settings.general.startupAndWindowDescription') }}
                    </p>
                </div>

                <div
                    data-testid="settings-general-card-launch"
                    class="settings-row-group divide-y divide-neutral-200/70"
                >
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                        <div
                            data-testid="settings-general-row-label"
                            class="text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.startOnBoot') }}
                        </div>
                        <button
                            :class="[
                                'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                                settings.startOnBoot ? 'settings-toggle-enabled' : 'bg-neutral-200',
                            ]"
                            @click="
                                settings.startOnBoot = !settings.startOnBoot;
                                saveStartOnBoot();
                            "
                        >
                            <span
                                :class="[
                                    'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                                    settings.startOnBoot ? 'translate-x-[18px]' : 'translate-x-1',
                                ]"
                            />
                        </button>
                    </div>

                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                        <div
                            data-testid="settings-general-row-label"
                            class="text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.startMinimized') }}
                        </div>
                        <button
                            :class="[
                                'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                                settings.startMinimized
                                    ? 'settings-toggle-enabled'
                                    : 'bg-neutral-200',
                            ]"
                            data-testid="settings-start-minimized-toggle"
                            :aria-pressed="settings.startMinimized"
                            @click="
                                settings.startMinimized = !settings.startMinimized;
                                saveStartMinimized();
                            "
                        >
                            <span
                                :class="[
                                    'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                                    settings.startMinimized
                                        ? 'translate-x-[18px]'
                                        : 'translate-x-1',
                                ]"
                            />
                        </button>
                    </div>

                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                    >
                        <label
                            data-testid="settings-general-row-label"
                            class="block text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.windowSize') }}
                        </label>
                        <div data-testid="settings-general-control" class="ml-auto w-[180px]">
                            <CustomSelect
                                v-model="settings.searchWindowSizePreset"
                                :options="searchWindowSizeOptions"
                                @update:model-value="saveSearchWindowSizePreset"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <div>
                    <h2 class="settings-section-title">
                        {{ t('settings.general.conversationExperience') }}
                    </h2>
                    <p class="settings-section-description">
                        {{ t('settings.general.conversationExperienceDescription') }}
                    </p>
                </div>

                <div data-testid="settings-general-card-conversation" class="settings-row-group">
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                    >
                        <label
                            data-testid="settings-general-row-label"
                            class="block text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.outputScrollBehavior') }}
                        </label>
                        <div data-testid="settings-general-control" class="ml-auto w-[180px]">
                            <CustomSelect
                                v-model="settings.outputScrollBehavior"
                                :options="outputScrollBehaviorOptions"
                                @update:model-value="saveOutputScrollBehavior"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <section class="space-y-4">
                <div>
                    <h2 class="settings-section-title">{{ t('settings.general.language') }}</h2>
                    <p class="settings-section-description">
                        {{ t('settings.general.languageDescription') }}
                    </p>
                </div>

                <div data-testid="settings-language-section" class="settings-row-group">
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
                    >
                        <label
                            data-testid="settings-general-row-label"
                            class="block text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.interfaceLanguage') }}
                        </label>
                        <div data-testid="settings-general-control" class="ml-auto w-[180px]">
                            <CustomSelect
                                v-model="pendingLanguage"
                                :options="languageOptions"
                                protect-option-text
                                @update:model-value="saveLanguage"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <UpdateSettingsSection />
        </div>
    </div>
</template>

<style scoped>
    .shortcut-capture-input {
        caret-color: transparent;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .shortcut-capture-input::selection {
        background: transparent;
    }

    .shortcut-capture-input::-moz-selection {
        background: transparent;
    }
</style>
