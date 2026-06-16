<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import { native } from '@services/NativeService';
    import { notify } from '@services/NotificationService';
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

    const shortcutInput = ref<HTMLInputElement | null>(null);
    const isSaving = ref(false);
    const isCapturing = ref(false);
    const hasCapturedShortcut = ref(false);
    const displayShortcut = ref('');
    const shortcutCapturePrompt = computed(() => t('settings.general.shortcutCapturePrompt'));
    const pendingLanguage = ref<AppLocale>(settings.value.language);
    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const shortcutRegistrationFailed = ref(false);

    // 键名映射表
    const keyNameMap: Record<string, string> = {
        Control: 'Ctrl',
        ' ': 'Space',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Escape: 'Esc',
        Delete: 'Del',
    };

    // 捕获快捷键
    const captureShortcut = (event: KeyboardEvent) => {
        if (!isCapturing.value) return;

        event.preventDefault();
        event.stopPropagation();

        // 忽略单独的修饰键和 Win 键
        if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(event.key)) {
            return;
        }

        // 不支持 Win 键组合
        if (event.metaKey) {
            alertMessage.value?.warning(t('settings.general.winKeyUnsupported'), 3000);
            return;
        }

        const modifiers: string[] = [];
        if (event.ctrlKey) modifiers.push('Ctrl');
        if (event.altKey) modifiers.push('Alt');
        if (event.shiftKey) modifiers.push('Shift');

        // 获取按键名称
        let keyName: string = event.key;

        // 使用映射表转换键名
        const mappedKey = keyNameMap[keyName];
        if (mappedKey) {
            keyName = mappedKey;
        } else if (keyName.length === 1) {
            // 单字符键转为大写
            keyName = keyName.toUpperCase();
        }

        // 组合快捷键字符串
        const shortcut = [...modifiers, keyName].join('+');
        displayShortcut.value = shortcut;
        hasCapturedShortcut.value = true;
    };

    // 开始捕获（输入框获得焦点）
    const startCapture = () => {
        isCapturing.value = true;
        hasCapturedShortcut.value = false;
        displayShortcut.value = shortcutCapturePrompt.value;
    };

    // 停止捕获并保存（输入框失去焦点）
    const stopCaptureAndSave = async () => {
        if (!isCapturing.value) return;

        isCapturing.value = false;

        const completion = resolveShortcutCaptureCompletion({
            currentShortcut: settings.value.globalShortcut,
            displayShortcut: displayShortcut.value,
            hasCapturedShortcut: hasCapturedShortcut.value,
        });

        displayShortcut.value = completion.displayShortcut;
        if (completion.action !== 'save') {
            return;
        }

        // 保存新快捷键
        await saveNewShortcut(completion.shortcut);
    };

    // 保存新快捷键的通用函数
    const saveNewShortcut = async (newShortcut: string) => {
        isSaving.value = true;
        shortcutRegistrationFailed.value = false;

        try {
            // 先注册到 Rust 端
            const registered = await registerShortcut(newShortcut);
            if (!registered) {
                shortcutRegistrationFailed.value = true;
                displayShortcut.value = newShortcut;
                return;
            }

            // 注册成功后保存到数据库
            await saveShortcutToDatabase(newShortcut);

            // 更新本地状态
            settings.value.globalShortcut = newShortcut;
            displayShortcut.value = newShortcut;
            alertMessage.value?.success(t('settings.general.shortcutSaved'), 3000);
        } catch (error) {
            console.error('Failed to save shortcut:', error);
            alertMessage.value?.error(t('settings.general.saveShortcutFailed'), 3000);
            // 恢复原值
            displayShortcut.value = settings.value.globalShortcut;
            shortcutRegistrationFailed.value = false;
        } finally {
            isSaving.value = false;
        }
    };

    // 使用建议的快捷键
    const useSuggestedShortcut = async (shortcut: string) => {
        // 如果正在捕获，先取消捕获
        if (isCapturing.value) {
            isCapturing.value = false;
        }

        // 如果输入框有焦点，先失焦
        if (shortcutInput.value) {
            shortcutInput.value.blur();
        }

        await saveNewShortcut(shortcut);
    };

    // 监听 isCapturing 状态，添加/移除全局键盘监听
    watch(isCapturing, (newValue) => {
        if (newValue) {
            window.addEventListener('keydown', captureShortcut);
        } else {
            window.removeEventListener('keydown', captureShortcut);
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

    // 从 store 加载设置
    const loadSettings = async () => {
        try {
            await settingsStore.initialize();
            displayShortcut.value = settings.value.globalShortcut;

            // 检查快捷键注册状态
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

    // 注册快捷键到 Rust 端
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

            // 发送系统通知
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

    // 保存快捷键到数据库并注册
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

        // 同步开机自启动状态
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

    // 组件卸载时清理事件监听
    onUnmounted(() => {
        window.removeEventListener('keydown', captureShortcut);
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
                    <p class="settings-section-description">
                        {{ t('settings.general.shortcutsDescription') }}
                    </p>
                </div>

                <div
                    data-testid="settings-general-card-shortcut"
                    class="settings-row-group divide-y divide-neutral-200/70"
                >
                    <div
                        class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_360px] sm:items-center"
                    >
                        <label
                            data-testid="settings-general-row-label"
                            class="text-[13px] leading-6 font-normal text-neutral-900"
                        >
                            {{ t('settings.general.activationShortcut') }}
                        </label>
                        <div class="min-w-0 justify-self-end">
                            <div
                                data-testid="settings-shortcut-control-row"
                                class="flex min-w-0 items-center justify-end gap-3 text-[11px]"
                            >
                                <div
                                    data-testid="settings-shortcut-suggestions"
                                    class="shrink-0 text-left whitespace-nowrap"
                                >
                                    <span class="text-[11px] text-neutral-400">
                                        {{ t('settings.general.suggestionsShort') }}
                                    </span>
                                    <button
                                        class="text-primary-700 decoration-primary-300 hover:text-primary-600 ml-2 font-mono text-[11px] underline underline-offset-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                        :disabled="isSaving"
                                        @click="useSuggestedShortcut('Alt+Space')"
                                    >
                                        Alt+Space
                                    </button>
                                    <span class="mx-1.5 text-neutral-300">|</span>
                                    <button
                                        class="text-primary-700 decoration-primary-300 hover:text-primary-600 font-mono text-[11px] underline underline-offset-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                        :disabled="isSaving"
                                        @click="useSuggestedShortcut('Ctrl+Space')"
                                    >
                                        Ctrl+Space
                                    </button>
                                </div>
                                <div data-testid="settings-general-control" class="w-[180px]">
                                    <div
                                        data-testid="settings-general-shortcut-input-wrap"
                                        class="relative ml-auto w-[180px] shrink-0"
                                    >
                                        <input
                                            ref="shortcutInput"
                                            v-model="displayShortcut"
                                            data-testid="settings-global-shortcut-input"
                                            type="text"
                                            readonly
                                            :class="[
                                                'w-full rounded-[10px] border px-3 py-2 text-center font-mono text-[12px] shadow-none [box-shadow:none] transition-colors focus:shadow-none focus:[box-shadow:none] focus:outline-none',
                                                shortcutRegistrationFailed
                                                    ? 'border-red-300 bg-red-50 text-red-600'
                                                    : isCapturing
                                                      ? 'border-primary-300 bg-white text-neutral-950'
                                                      : 'focus:border-primary-300 border-transparent bg-[#f0f0ef] text-neutral-900 hover:bg-[#ececea]',
                                                isSaving
                                                    ? 'cursor-wait opacity-50'
                                                    : 'cursor-pointer',
                                            ]"
                                            :disabled="isSaving"
                                            :placeholder="t('settings.general.shortcutPlaceholder')"
                                            @focus="startCapture"
                                            @blur="stopCaptureAndSave"
                                        />
                                        <span
                                            v-if="shortcutRegistrationFailed"
                                            data-testid="settings-shortcut-occupied-indicator"
                                            class="absolute top-1/2 right-2.5 flex h-4 w-4 -translate-y-1/2 items-center justify-center text-red-500"
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

                <div
                    data-testid="settings-general-card-conversation"
                    class="settings-row-group divide-y divide-neutral-200/70"
                >
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
