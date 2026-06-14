<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import AppIcon from '@components/AppIcon.vue';
    import {
        AppEvent,
        eventService,
        type ShortcutCaptureSystemKeyEvent,
    } from '@services/EventService';
    import type { UnlistenFn } from '@tauri-apps/api/event';
    import { storeToRefs } from 'pinia';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import {
        getSearchKeybindingDefinition,
        SEARCH_KEYBINDING_DEFINITIONS,
        type SearchKeybindingActionId,
    } from '@/config/searchKeybindings';
    import { type MessageKey, type MessageParams, t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';
    import {
        captureShortcutFromKeyboardEvent,
        findShortcutConflict,
        formatShortcutForDisplay,
        hasCommandModifier,
        isMacPlatform,
        isModifierlessFunctionShortcut,
        isReservedLocalShortcut,
        isReservedLocalShortcutKey,
        normalizeLocalShortcutString,
        toCurrentPlatformShortcut,
    } from '@/utils/shortcuts';

    defineOptions({
        name: 'SettingsSearchShortcutSettings',
    });

    type SearchShortcutIconAction = 'clear' | 'restore';
    type SearchShortcutGroupId = 'session' | 'inputAndRequest' | 'window';

    interface SettingsSearchShortcutGroupRow {
        kind: 'configurable' | 'fixed';
        id: string;
        label: string;
        description?: string;
        displayValue: string;
        isCapturing?: boolean;
        hasError?: boolean;
        shortcutAction?: SearchShortcutIconAction;
        shortcutActionLabel?: string;
    }

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);

    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const isSaving = ref(false);
    const activeSearchShortcutActionId = ref<SearchKeybindingActionId | null>(null);
    const searchShortcutCapturedValue = ref<string | null>(null);
    const hasCapturedSearchShortcut = ref(false);
    const searchShortcutErrorActionId = ref<SearchKeybindingActionId | null>(null);
    const shortcutCapturePrompt = computed(() => t('settings.general.shortcutCapturePrompt'));
    let unlistenSystemKey: UnlistenFn | null = null;

    function formatSearchShortcutForSettings(shortcut: string | null | undefined): string {
        const normalizedShortcut = normalizeLocalShortcutString(shortcut);
        return normalizedShortcut
            ? formatShortcutForDisplay(normalizedShortcut)
            : t('settings.general.noShortcut');
    }

    const searchShortcutDisplayMap = ref<Record<SearchKeybindingActionId, string>>(
        SEARCH_KEYBINDING_DEFINITIONS.reduce(
            (accumulator, definition) => {
                accumulator[definition.id] = formatSearchShortcutForSettings(
                    settings.value.searchKeybindings[definition.id]
                );
                return accumulator;
            },
            {} as Record<SearchKeybindingActionId, string>
        )
    );

    const fixedSearchShortcutRows = computed<
        Record<SearchShortcutGroupId, SettingsSearchShortcutGroupRow[]>
    >(() => ({
        session: [
            {
                kind: 'fixed',
                id: 'search.inputHistory.older',
                label: t('settings.general.fixedSearchActions.previousInputHistory'),
                description: t('settings.general.searchActionDescriptions.previousInputHistory'),
                displayValue: 'Up',
            },
            {
                kind: 'fixed',
                id: 'search.inputHistory.newer',
                label: t('settings.general.fixedSearchActions.nextInputHistory'),
                description: t('settings.general.searchActionDescriptions.nextInputHistory'),
                displayValue: 'Down',
            },
        ],
        inputAndRequest: [
            {
                kind: 'fixed',
                id: 'search.request.cancel',
                label: t('settings.general.searchActions.cancelRequest'),
                description: t('settings.general.searchActionDescriptions.cancelRequest'),
                displayValue: 'Esc',
            },
            {
                kind: 'fixed',
                id: 'search.submit',
                label: t('settings.general.fixedSearchActions.submitRequest'),
                description: t('settings.general.searchActionDescriptions.submitRequest'),
                displayValue: 'Enter',
            },
            {
                kind: 'fixed',
                id: 'search.newLine',
                label: t('settings.general.fixedSearchActions.newLine'),
                description: t('settings.general.searchActionDescriptions.newLine'),
                displayValue: 'Shift+Enter',
            },
        ],
        window: [],
    }));

    const searchShortcutRows = computed<SettingsSearchShortcutGroupRow[]>(() =>
        SEARCH_KEYBINDING_DEFINITIONS.map((definition) => {
            const currentShortcut = settings.value.searchKeybindings[definition.id];
            const isDefaultShortcut =
                normalizeLocalShortcutString(currentShortcut) ===
                normalizeLocalShortcutString(definition.defaultShortcut);
            const shortcutAction: SearchShortcutIconAction = isDefaultShortcut
                ? 'clear'
                : 'restore';

            return {
                ...definition,
                kind: 'configurable',
                label: t(definition.labelKey),
                description: t(definition.descriptionKey),
                displayValue: searchShortcutDisplayMap.value[definition.id],
                isCapturing: activeSearchShortcutActionId.value === definition.id,
                hasError: searchShortcutErrorActionId.value === definition.id,
                shortcutAction,
                shortcutActionLabel:
                    shortcutAction === 'clear'
                        ? t('common.clear')
                        : `${t('window.restore')} ${t('common.default')}`,
            };
        })
    );

    const searchShortcutGroups = computed(() => {
        const rowById = new Map<string, SettingsSearchShortcutGroupRow>(
            searchShortcutRows.value.map((row) => [row.id, row] as const)
        );
        const groups: Array<{
            id: SearchShortcutGroupId;
            title: string;
            actionIds: SearchKeybindingActionId[];
        }> = [
            {
                id: 'session',
                title: t('settings.general.searchShortcutGroups.session'),
                actionIds: [
                    'search.history.open',
                    'search.session.new',
                    'search.session.reopenLastClosed',
                ],
            },
            {
                id: 'inputAndRequest',
                title: t('settings.general.searchShortcutGroups.inputAndRequest'),
                actionIds: [
                    'search.input.focus',
                    'search.model.toggle',
                    'search.quickSearch.toggleView',
                ],
            },
            {
                id: 'window',
                title: t('settings.general.searchShortcutGroups.window'),
                actionIds: ['search.window.pin', 'search.window.maximize', 'search.settings.open'],
            },
        ];

        return groups.map((group) => ({
            title: group.title,
            rows: [
                ...group.actionIds
                    .map((actionId) => rowById.get(actionId))
                    .filter((row): row is SettingsSearchShortcutGroupRow => Boolean(row)),
                ...fixedSearchShortcutRows.value[group.id],
            ],
        }));
    });

    function updateSearchShortcutDisplay(actionId: SearchKeybindingActionId, value: string) {
        searchShortcutDisplayMap.value = {
            ...searchShortcutDisplayMap.value,
            [actionId]: value,
        };
    }

    function syncSearchShortcutDisplays() {
        const next = { ...searchShortcutDisplayMap.value };
        for (const definition of SEARCH_KEYBINDING_DEFINITIONS) {
            if (activeSearchShortcutActionId.value === definition.id) {
                continue;
            }
            next[definition.id] = formatSearchShortcutForSettings(
                settings.value.searchKeybindings[definition.id]
            );
        }
        searchShortcutDisplayMap.value = next;
    }

    function reportSearchShortcutError(
        actionId: SearchKeybindingActionId,
        messageKey: MessageKey,
        params?: MessageParams
    ) {
        searchShortcutErrorActionId.value = actionId;
        alertMessage.value?.error(t(messageKey, params), 3000);
    }

    function isModifierOnlyKey(key: string) {
        return (
            key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta' || key === 'OS'
        );
    }

    const captureSearchShortcut = (event: KeyboardEvent) => {
        const actionId = activeSearchShortcutActionId.value;
        if (!actionId) {
            return;
        }

        if (isReservedLocalShortcutKey(event.key, event.code)) {
            return;
        }

        const captured = captureShortcutFromKeyboardEvent(event);
        if (!captured) {
            if (isModifierOnlyKey(event.key)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (!isMacPlatform() && event.metaKey) {
                alertMessage.value?.warning(t('settings.general.winKeyUnsupported'), 3000);
                return;
            }

            reportSearchShortcutError(
                actionId,
                'settings.general.searchShortcuts.errors.unsupported'
            );
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
            );
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        searchShortcutCapturedValue.value = captured.shortcut;
        hasCapturedSearchShortcut.value = true;
        searchShortcutErrorActionId.value = null;
        updateSearchShortcutDisplay(actionId, captured.displayShortcut);
        void confirmCapturedSearchShortcut(actionId, captured.shortcut);
    };

    const handleSystemKeyCapture = (payload: ShortcutCaptureSystemKeyEvent) => {
        const actionId = activeSearchShortcutActionId.value;
        if (!actionId) {
            return;
        }

        const modifiers: string[] = [];
        if (payload.ctrl) {
            modifiers.push(isMacPlatform() ? 'Ctrl' : 'Mod');
        }
        if (payload.alt) {
            modifiers.push('Alt');
        }
        if (payload.shift) {
            modifiers.push('Shift');
        }

        const shortcut = normalizeLocalShortcutString([...modifiers, payload.key].join('+'));
        if (!shortcut) {
            reportSearchShortcutError(
                actionId,
                'settings.general.searchShortcuts.errors.unsupported'
            );
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
            );
            return;
        }

        searchShortcutCapturedValue.value = shortcut;
        hasCapturedSearchShortcut.value = true;
        searchShortcutErrorActionId.value = null;
        updateSearchShortcutDisplay(actionId, formatShortcutForDisplay(shortcut));
        void confirmCapturedSearchShortcut(actionId, shortcut);
    };

    async function saveSearchShortcut(
        actionId: SearchKeybindingActionId,
        shortcut: string | null
    ): Promise<boolean> {
        const normalizedShortcut =
            shortcut === null ? null : normalizeLocalShortcutString(shortcut);

        if (shortcut !== null && !normalizedShortcut) {
            reportSearchShortcutError(
                actionId,
                'settings.general.searchShortcuts.errors.unsupported'
            );
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
            );
            return false;
        }

        if (normalizedShortcut) {
            const definition = getSearchKeybindingDefinition(actionId);
            const allowsModifierlessFunctionShortcut =
                definition.allowModifierlessFunctionShortcut &&
                isModifierlessFunctionShortcut(normalizedShortcut);

            if (!hasCommandModifier(normalizedShortcut) && !allowsModifierlessFunctionShortcut) {
                reportSearchShortcutError(
                    actionId,
                    'settings.general.searchShortcuts.errors.modifierRequired'
                );
                updateSearchShortcutDisplay(
                    actionId,
                    formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
                );
                return false;
            }

            if (isReservedLocalShortcut(normalizedShortcut)) {
                reportSearchShortcutError(
                    actionId,
                    'settings.general.searchShortcuts.errors.reserved'
                );
                updateSearchShortcutDisplay(
                    actionId,
                    formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
                );
                return false;
            }

            const conflictActionId = findShortcutConflict(
                normalizedShortcut,
                SEARCH_KEYBINDING_DEFINITIONS.map((definition) => ({
                    id: definition.id,
                    shortcut: settings.value.searchKeybindings[definition.id],
                })),
                actionId
            );
            if (conflictActionId) {
                reportSearchShortcutError(
                    actionId,
                    'settings.general.searchShortcuts.errors.duplicate',
                    {
                        action: t(getSearchKeybindingDefinition(conflictActionId).labelKey),
                    }
                );
                updateSearchShortcutDisplay(
                    actionId,
                    formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
                );
                return false;
            }

            const comparableGlobalShortcut = normalizeLocalShortcutString(
                settings.value.globalShortcut
            );
            const comparableLocalShortcut = normalizeLocalShortcutString(
                toCurrentPlatformShortcut(normalizedShortcut)
            );
            if (
                comparableGlobalShortcut &&
                comparableLocalShortcut &&
                comparableGlobalShortcut === comparableLocalShortcut
            ) {
                reportSearchShortcutError(
                    actionId,
                    'settings.general.searchShortcuts.errors.globalConflict'
                );
                updateSearchShortcutDisplay(
                    actionId,
                    formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
                );
                return false;
            }
        }

        isSaving.value = true;
        searchShortcutErrorActionId.value = null;
        try {
            await settingsStore.updateSearchKeybindings({
                ...settings.value.searchKeybindings,
                [actionId]: normalizedShortcut,
            });
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(normalizedShortcut)
            );
            alertMessage.value?.success(t('common.saved'), 2000);
            return true;
        } catch (error) {
            console.error('Failed to save search shortcut:', error);
            reportSearchShortcutError(actionId, 'settings.general.saveSettingsFailed');
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
            );
            return false;
        } finally {
            isSaving.value = false;
        }
    }

    function startSearchShortcutCapture(rowOrActionId: SettingsSearchShortcutGroupRow | string) {
        if (typeof rowOrActionId === 'string') {
            const actionId = rowOrActionId as SearchKeybindingActionId;
            activeSearchShortcutActionId.value = actionId;
            hasCapturedSearchShortcut.value = false;
            searchShortcutCapturedValue.value = null;
            searchShortcutErrorActionId.value = null;
            updateSearchShortcutDisplay(actionId, shortcutCapturePrompt.value);
            return;
        }

        if (rowOrActionId.kind !== 'configurable') {
            return;
        }

        const actionId = rowOrActionId.id as SearchKeybindingActionId;
        activeSearchShortcutActionId.value = actionId;
        hasCapturedSearchShortcut.value = false;
        searchShortcutCapturedValue.value = null;
        searchShortcutErrorActionId.value = null;
        updateSearchShortcutDisplay(actionId, shortcutCapturePrompt.value);
    }

    function focusSearchShortcutInput(event: MouseEvent, row: SettingsSearchShortcutGroupRow) {
        event.preventDefault();
        if (row.kind !== 'configurable') {
            return;
        }

        (event.currentTarget as HTMLInputElement).focus();
    }

    function clearSearchShortcutSelection(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const cursorPosition = input.value.length;
        input.setSelectionRange(cursorPosition, cursorPosition);
    }

    async function confirmCapturedSearchShortcut(
        actionId: SearchKeybindingActionId,
        shortcut: string
    ) {
        if (activeSearchShortcutActionId.value !== actionId) {
            return;
        }

        hasCapturedSearchShortcut.value = false;
        searchShortcutCapturedValue.value = null;

        if (
            normalizeLocalShortcutString(shortcut) ===
            normalizeLocalShortcutString(settings.value.searchKeybindings[actionId])
        ) {
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
            );
            activeSearchShortcutActionId.value = null;
            return;
        }

        const saved = await saveSearchShortcut(actionId, shortcut);
        if (saved) {
            activeSearchShortcutActionId.value = null;
        }
    }

    async function stopSearchShortcutCaptureAndSave(
        rowOrActionId: SettingsSearchShortcutGroupRow | string
    ) {
        const actionId =
            typeof rowOrActionId === 'string'
                ? (rowOrActionId as SearchKeybindingActionId)
                : rowOrActionId.kind === 'configurable'
                  ? (rowOrActionId.id as SearchKeybindingActionId)
                  : null;
        if (!actionId || activeSearchShortcutActionId.value !== actionId) {
            return;
        }

        activeSearchShortcutActionId.value = null;

        if (!hasCapturedSearchShortcut.value || !searchShortcutCapturedValue.value) {
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
            );
            return;
        }

        if (
            normalizeLocalShortcutString(searchShortcutCapturedValue.value) ===
            normalizeLocalShortcutString(settings.value.searchKeybindings[actionId])
        ) {
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
            );
            return;
        }

        await saveSearchShortcut(actionId, searchShortcutCapturedValue.value);
    }

    async function resetSearchShortcut(actionId: SearchKeybindingActionId) {
        await saveSearchShortcut(actionId, getSearchKeybindingDefinition(actionId).defaultShortcut);
    }

    async function disableSearchShortcut(actionId: SearchKeybindingActionId) {
        await saveSearchShortcut(actionId, null);
    }

    async function handleSearchShortcutIconAction(
        rowOrActionId: SettingsSearchShortcutGroupRow | string,
        explicitAction?: SearchShortcutIconAction
    ) {
        const actionId =
            typeof rowOrActionId === 'string'
                ? (rowOrActionId as SearchKeybindingActionId)
                : rowOrActionId.kind === 'configurable'
                  ? (rowOrActionId.id as SearchKeybindingActionId)
                  : null;
        const action =
            explicitAction ??
            (typeof rowOrActionId === 'string'
                ? undefined
                : rowOrActionId.kind === 'configurable'
                  ? rowOrActionId.shortcutAction
                  : undefined);
        if (!actionId || !action) {
            return;
        }

        if (activeSearchShortcutActionId.value === actionId) {
            activeSearchShortcutActionId.value = null;
            hasCapturedSearchShortcut.value = false;
            searchShortcutCapturedValue.value = null;
            updateSearchShortcutDisplay(
                actionId,
                formatSearchShortcutForSettings(settings.value.searchKeybindings[actionId])
            );
        }

        if (action === 'clear') {
            await disableSearchShortcut(actionId);
            return;
        }

        await resetSearchShortcut(actionId);
    }

    watch(activeSearchShortcutActionId, (actionId) => {
        window.removeEventListener('keydown', captureSearchShortcut);
        if (actionId) {
            window.addEventListener('keydown', captureSearchShortcut);
        }
    });

    watch(
        () => settings.value.searchKeybindings,
        () => {
            syncSearchShortcutDisplays();
        },
        { deep: true, immediate: true }
    );

    onMounted(async () => {
        try {
            unlistenSystemKey = await eventService.on(
                AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY,
                handleSystemKeyCapture
            );
        } catch (error) {
            console.error('Failed to subscribe to search shortcut system key event:', error);
        }
    });

    onUnmounted(() => {
        window.removeEventListener('keydown', captureSearchShortcut);
        unlistenSystemKey?.();
        unlistenSystemKey = null;
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div v-for="group in searchShortcutGroups" :key="group.title" class="space-y-2">
        <div class="text-[12px] leading-5 font-medium text-neutral-500">
            {{ group.title }}
        </div>
        <div class="settings-row-group divide-y divide-neutral-200/70">
            <div
                v-for="row in group.rows"
                :key="row.id"
                class="grid min-w-0 gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center"
            >
                <div
                    data-testid="settings-general-row-label"
                    class="min-w-0 text-[13px] leading-6 font-normal text-neutral-900"
                >
                    <div>{{ row.label }}</div>
                    <div v-if="row.description" class="text-[12px] leading-5 text-neutral-500">
                        {{ row.description }}
                    </div>
                </div>
                <div class="min-w-0 justify-self-end">
                    <div class="flex min-w-0 items-center justify-end">
                        <div class="relative w-[220px] shrink-0">
                            <input
                                :value="row.displayValue"
                                :data-testid="`settings-search-shortcut-input-${row.id}`"
                                type="text"
                                readonly
                                :class="[
                                    'shortcut-capture-input w-full rounded-[10px] border px-9 py-2 text-center text-[12px] shadow-none [box-shadow:none] transition-colors select-none focus:shadow-none focus:[box-shadow:none] focus:outline-none',
                                    row.hasError
                                        ? 'border-red-300 bg-red-50 text-red-600'
                                        : row.isCapturing
                                          ? 'border-primary-300 bg-white text-neutral-950'
                                          : 'focus:border-primary-300 border-transparent bg-[#f0f0ef] text-neutral-900 hover:bg-[#ececea]',
                                    isSaving
                                        ? 'cursor-wait opacity-50'
                                        : row.shortcutAction
                                          ? 'cursor-pointer'
                                          : 'cursor-default',
                                ]"
                                :disabled="isSaving"
                                :placeholder="t('settings.general.shortcutPlaceholder')"
                                :title="
                                    row.kind === 'fixed'
                                        ? t('settings.general.searchShortcuts.fixedUnavailable')
                                        : undefined
                                "
                                :tabindex="row.kind === 'fixed' ? -1 : 0"
                                @mousedown="focusSearchShortcutInput($event, row)"
                                @select="clearSearchShortcutSelection"
                                @dragstart.prevent
                                @focus="startSearchShortcutCapture(row)"
                                @blur="stopSearchShortcutCaptureAndSave(row)"
                            />
                            <button
                                v-if="row.shortcutAction"
                                type="button"
                                class="absolute top-1/2 right-2.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
                                :disabled="isSaving"
                                :title="row.shortcutActionLabel"
                                :aria-label="row.shortcutActionLabel"
                                :data-testid="`settings-search-shortcut-action-${row.id}`"
                                :data-shortcut-action="row.shortcutAction"
                                @mousedown.prevent
                                @click="handleSearchShortcutIconAction(row.id, row.shortcutAction)"
                            >
                                <AppIcon
                                    :name="row.shortcutAction === 'clear' ? 'x' : 'undo'"
                                    class="h-4 w-4"
                                />
                            </button>
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
