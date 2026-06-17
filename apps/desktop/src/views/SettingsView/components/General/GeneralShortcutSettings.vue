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
        getSearchKeybindingDefinition,
        type SearchKeybindingActionId,
    } from '@/config/searchKeybindings';
    import { type MessageKey, type MessageParams, t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';
    import {
        captureShortcutFromKeyboardEvent,
        formatShortcutForDisplay,
        hasCommandModifier,
        isMacPlatform,
        isReservedGlobalShortcut,
        isReservedLocalShortcutKey,
        normalizeLocalShortcutString,
    } from '@/utils/shortcuts';

    import { resolveShortcutCaptureCompletion } from './shortcutCapture';

    defineOptions({
        name: 'SettingsGeneralShortcutSettings',
    });

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);

    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const isSaving = ref(false);
    const isCapturing = ref(false);
    const hasCapturedShortcut = ref(false);
    const displayShortcut = ref('');
    const shortcutCapturePrompt = computed(() => t('settings.general.shortcutCapturePrompt'));
    const shortcutRegistrationFailed = ref(false);
    const showGlobalShortcutPresetMenu = ref(false);
    const globalShortcutPresetOptions = computed(() => {
        const shortcuts = isMacPlatform()
            ? ['Option+Space', 'Option+Shift+Space']
            : ['Alt+Space', 'Ctrl+Space'];

        return shortcuts.map((shortcut) => ({
            label: shortcut,
            value: shortcut,
        }));
    });

    function formatGlobalShortcutForSettings(shortcut: string | null | undefined): string {
        return formatShortcutForDisplay(shortcut);
    }

    function findGlobalShortcutSearchConflict(shortcut: string): SearchKeybindingActionId | null {
        const normalizedShortcut = normalizeLocalShortcutString(shortcut);
        if (!normalizedShortcut) {
            return null;
        }

        for (const [actionId, searchShortcut] of Object.entries(
            settings.value.searchKeybindings
        ) as Array<[SearchKeybindingActionId, string | null]>) {
            const normalizedSearchShortcut = normalizeLocalShortcutString(searchShortcut);
            if (normalizedSearchShortcut === normalizedShortcut) {
                return actionId;
            }
        }

        return null;
    }

    function consumeShortcutCaptureEvent(event: KeyboardEvent) {
        event.preventDefault();
        event.stopPropagation();
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
            if (!isMacPlatform() && event.metaKey) {
                consumeShortcutCaptureEvent(event);
                alertMessage.value?.warning(t('settings.general.winKeyUnsupported'), 3000);
            }
            return;
        }

        if (!hasCommandModifier(captured.shortcut)) {
            consumeShortcutCaptureEvent(event);
            alertMessage.value?.warning(
                t('settings.general.searchShortcuts.errors.modifierRequired'),
                3000
            );
            return;
        }

        consumeShortcutCaptureEvent(event);
        displayShortcut.value = captured.displayShortcut;
        hasCapturedShortcut.value = true;
        showGlobalShortcutPresetMenu.value = false;
        void confirmCapturedShortcut(captured.displayShortcut);
    };

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

        displayShortcut.value = formatGlobalShortcutForSettings(shortcut);
        hasCapturedShortcut.value = true;
        showGlobalShortcutPresetMenu.value = false;
        void confirmCapturedShortcut(displayShortcut.value);
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

        if (
            normalizeLocalShortcutString(shortcut) ===
            normalizeLocalShortcutString(settings.value.globalShortcut)
        ) {
            displayShortcut.value = formatGlobalShortcutForSettings(settings.value.globalShortcut);
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
            currentShortcut: formatGlobalShortcutForSettings(settings.value.globalShortcut),
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
        if (isReservedGlobalShortcut(newShortcut)) {
            shortcutRegistrationFailed.value = false;
            displayShortcut.value = formatGlobalShortcutForSettings(settings.value.globalShortcut);
            alertMessage.value?.warning(t('settings.general.globalShortcutReservedOnMac'), 4000);
            return;
        }

        const conflictActionId = findGlobalShortcutSearchConflict(newShortcut);
        if (conflictActionId) {
            shortcutRegistrationFailed.value = false;
            displayShortcut.value = formatGlobalShortcutForSettings(settings.value.globalShortcut);
            alertMessage.value?.error(
                t('settings.general.searchShortcuts.errors.duplicate', {
                    action: t(getSearchKeybindingDefinition(conflictActionId).labelKey),
                }),
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
                displayShortcut.value = formatGlobalShortcutForSettings(newShortcut);
                return;
            }

            await saveShortcutToDatabase(newShortcut);
            settings.value.globalShortcut = newShortcut;
            displayShortcut.value = formatGlobalShortcutForSettings(newShortcut);
            alertMessage.value?.success(t('settings.general.shortcutSaved'), 3000);
        } catch (error) {
            console.error('Failed to save shortcut:', error);
            alertMessage.value?.error(t('settings.general.saveShortcutFailed'), 3000);
            displayShortcut.value = formatGlobalShortcutForSettings(settings.value.globalShortcut);
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
                displayShortcut.value = formatGlobalShortcutForSettings(shortcut);
            }
        }
    );

    const loadSettings = async () => {
        try {
            await settingsStore.initialize();
            displayShortcut.value = formatGlobalShortcutForSettings(settings.value.globalShortcut);

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
    });

    onUnmounted(() => {
        window.removeEventListener('keydown', captureShortcut, { capture: true });
        unlistenSystemKey?.();
        unlistenSystemKey = null;
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div data-testid="settings-general-shortcut-section">
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
                                            :placeholder="t('settings.general.shortcutPlaceholder')"
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
                                    :title="t('settings.general.shortcutRegistrationFailed')"
                                >
                                    <AppIcon name="exclamation-triangle" class="h-3.5 w-3.5" />
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
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
