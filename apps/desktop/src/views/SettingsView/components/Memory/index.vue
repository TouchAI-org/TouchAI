<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import AppIcon from '@components/AppIcon.vue';
    import { useContextMenu } from '@composables/useContextMenu.ts';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import {
        createMemoryItem,
        deleteMemoryItem,
        findMemoryDirectoryItems,
        readMemoryItemsByIds,
        updateMemoryItem,
    } from '@database/queries/memoryItems';
    import type { MemoryDirectoryItemEntity, MemoryItemEntity } from '@database/types';
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import { useSettingsResizablePanel } from '../../composables/useSettingsResizablePanel';

    defineOptions({
        name: 'SettingsMemorySection',
    });

    interface MemoryEditorState {
        title: string;
        applicability: string;
        content: string;
    }

    const AUTOSAVE_DELAY_MS = 900;
    const TITLE_MAX_LENGTH = 24;
    const APPLICABILITY_MAX_LENGTH = 48;

    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const {
        handleResizeKeyDown,
        handleResizePointerDown,
        panelMaxWidth,
        panelMinWidth,
        panelStyle,
        panelWidth,
    } = useSettingsResizablePanel();
    const contentScrollRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(contentScrollRef);

    const loading = ref(true);
    const loadError = ref(false);
    const saving = ref(false);
    const queuedAutosave = ref(false);
    const deletingIds = ref<Set<number>>(new Set());
    const togglingIds = ref<Set<number>>(new Set());
    const directoryItems = ref<MemoryDirectoryItemEntity[]>([]);
    const editorMode = ref<'draft' | 'persisted' | null>(null);
    const selectedPersistedId = ref<number | null>(null);
    const editorState = ref<MemoryEditorState | null>(null);
    const lastHydratedSignature = ref('');
    let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
    let persistPromise: Promise<void> | null = null;

    const sortedDirectoryItems = computed(() =>
        [...directoryItems.value].sort(
            (left, right) =>
                Number(right.enabled) - Number(left.enabled) ||
                String(right.updated_at).localeCompare(String(left.updated_at)) ||
                right.id - left.id
        )
    );
    const hasMemories = computed(() => sortedDirectoryItems.value.length > 0);
    const showSidebar = computed(() => hasMemories.value);
    const showEditor = computed(() => editorState.value !== null);
    const showLoadErrorState = computed(
        () => !loading.value && loadError.value && !hasMemories.value && !showEditor.value
    );
    const showEmptyWorkspace = computed(
        () => !loading.value && !loadError.value && !hasMemories.value && !showEditor.value
    );
    const pageTitle = computed(() => {
        const title = editorState.value?.title.trim();
        return title || t('settings.nav.memory.label');
    });
    const editorSignature = computed(() =>
        editorState.value ? serializeEditorState(editorState.value) : ''
    );

    const { open: openMemoryMenu } = useContextMenu<number>(
        () => [{ key: 'delete', label: t('common.delete'), icon: 'trash', danger: true }],
        (key, memoryId) => {
            if (key === 'delete') {
                void handleDeleteMemory(memoryId);
            }
        }
    );

    watch(editorSignature, (nextSignature) => {
        if (!editorState.value) {
            clearAutosaveTimer();
            return;
        }

        if (nextSignature === lastHydratedSignature.value) {
            clearAutosaveTimer();
            return;
        }

        scheduleAutosave();
    });

    function cloneEditorState(memory: MemoryEditorState): MemoryEditorState {
        return {
            title: memory.title,
            applicability: memory.applicability,
            content: memory.content,
        };
    }

    function serializeEditorState(memory: MemoryEditorState): string {
        return JSON.stringify(memory);
    }

    function trimEditorState(memory: MemoryEditorState): MemoryEditorState {
        return {
            title: memory.title.trim(),
            applicability: memory.applicability.trim(),
            content: memory.content.trim(),
        };
    }

    function isCompleteEditorState(memory: MemoryEditorState): boolean {
        return Boolean(memory.title && memory.applicability && memory.content);
    }

    function clearAutosaveTimer() {
        if (!autosaveTimer) {
            return;
        }

        clearTimeout(autosaveTimer);
        autosaveTimer = null;
    }

    function hasPendingCompleteAutosave(state = editorState.value): boolean {
        if (!state) {
            return false;
        }

        const trimmedState = trimEditorState(state);
        if (!isCompleteEditorState(trimmedState)) {
            return false;
        }

        return serializeEditorState(trimmedState) !== lastHydratedSignature.value;
    }

    function hydrateEditor(
        mode: 'draft' | 'persisted',
        memory: MemoryEditorState,
        persistedId?: number | null
    ) {
        const nextState = cloneEditorState(memory);
        editorMode.value = mode;
        selectedPersistedId.value = mode === 'persisted' ? (persistedId ?? null) : null;
        editorState.value = nextState;
        lastHydratedSignature.value = serializeEditorState(nextState);
        clearAutosaveTimer();
    }

    function resetEditor() {
        editorMode.value = null;
        selectedPersistedId.value = null;
        editorState.value = null;
        lastHydratedSignature.value = '';
        clearAutosaveTimer();
    }

    function upsertDirectoryItem(memory: MemoryItemEntity) {
        const nextItem: MemoryDirectoryItemEntity = {
            id: memory.id,
            title: memory.title,
            applicability: memory.applicability,
            enabled: memory.enabled,
            updated_at: memory.updated_at,
        };
        const existingIndex = directoryItems.value.findIndex((item) => item.id === memory.id);

        if (existingIndex === -1) {
            directoryItems.value = [nextItem, ...directoryItems.value];
            return;
        }

        directoryItems.value = directoryItems.value.map((item) =>
            item.id === memory.id ? nextItem : item
        );
    }

    function updateDirectoryItemEnabled(memoryId: number, enabled: number, updatedAt?: string) {
        directoryItems.value = directoryItems.value.map((item) =>
            item.id === memoryId
                ? {
                      ...item,
                      enabled,
                      updated_at: updatedAt ?? item.updated_at,
                  }
                : item
        );
    }

    function removeDirectoryItem(memoryId: number) {
        directoryItems.value = directoryItems.value.filter((item) => item.id !== memoryId);
    }

    async function loadPersistedMemory(id: number) {
        try {
            const [memory] = await readMemoryItemsByIds([id]);
            if (!memory) {
                directoryItems.value = directoryItems.value.filter((item) => item.id !== id);
                if (selectedPersistedId.value === id) {
                    resetEditor();
                }
                return;
            }

            hydrateEditor('persisted', memory, id);
        } catch (error) {
            console.error('[SettingsMemorySection] Failed to load memory:', error);
            alertMessage.value?.error(t('settings.memory.loadFailed'), 6000);
        }
    }

    async function loadMemories(preferredSelectedId?: number) {
        loading.value = true;

        try {
            const items = await findMemoryDirectoryItems();
            directoryItems.value = items;
            loadError.value = false;

            if (editorMode.value === 'draft' && !preferredSelectedId) {
                return;
            }

            const sorted = [...items].sort(
                (left, right) =>
                    Number(right.enabled) - Number(left.enabled) ||
                    String(right.updated_at).localeCompare(String(left.updated_at)) ||
                    right.id - left.id
            );
            const nextSelectedId =
                preferredSelectedId && items.some((item) => item.id === preferredSelectedId)
                    ? preferredSelectedId
                    : selectedPersistedId.value &&
                        items.some((item) => item.id === selectedPersistedId.value)
                      ? selectedPersistedId.value
                      : sorted[0]?.id;

            if (nextSelectedId) {
                await loadPersistedMemory(nextSelectedId);
            } else if (editorMode.value !== 'draft') {
                resetEditor();
            }
        } catch (error) {
            console.error('[SettingsMemorySection] Failed to load memories:', error);
            loadError.value = true;
            alertMessage.value?.error(t('settings.memory.loadFailed'), 6000);
        } finally {
            loading.value = false;
        }
    }

    async function flushPendingAutosave(): Promise<boolean> {
        if (!hasPendingCompleteAutosave()) {
            clearAutosaveTimer();
            return true;
        }

        await persistEditorState();

        if (hasPendingCompleteAutosave()) {
            await persistEditorState();
        }

        return !hasPendingCompleteAutosave();
    }

    async function openDraftEditor() {
        if (editorMode.value === 'draft' && editorState.value) {
            return;
        }

        if (!(await flushPendingAutosave())) {
            return;
        }

        hydrateEditor(
            'draft',
            {
                title: '',
                applicability: '',
                content: '',
            },
            null
        );
    }

    async function handleSelectMemory(id: number) {
        if (!(await flushPendingAutosave())) {
            return;
        }

        if (editorMode.value === 'draft') {
            resetEditor();
        }

        await loadPersistedMemory(id);
    }

    function scheduleAutosave() {
        clearAutosaveTimer();
        autosaveTimer = setTimeout(() => {
            void persistEditorState();
        }, AUTOSAVE_DELAY_MS);
    }

    async function persistEditorState() {
        clearAutosaveTimer();

        if (persistPromise) {
            queuedAutosave.value = true;
            await persistPromise;
            return;
        }

        const currentState = editorState.value;
        if (!currentState) {
            return;
        }

        const trimmedState = trimEditorState(currentState);
        if (!isCompleteEditorState(trimmedState)) {
            return;
        }

        const nextSignature = serializeEditorState(trimmedState);
        if (nextSignature === lastHydratedSignature.value) {
            return;
        }

        const currentMode = editorMode.value;
        const currentPersistedId = selectedPersistedId.value;

        persistPromise = (async () => {
            saving.value = true;

            try {
                if (currentMode === 'draft') {
                    const created = await createMemoryItem({
                        ...trimmedState,
                        enabled: 1,
                    });
                    upsertDirectoryItem(created);
                    hydrateEditor('persisted', created, created.id);
                    return;
                }

                if (currentMode !== 'persisted' || !currentPersistedId) {
                    return;
                }

                const updated = await updateMemoryItem(currentPersistedId, trimmedState);
                if (!updated) {
                    return;
                }

                upsertDirectoryItem(updated);
                hydrateEditor('persisted', updated, updated.id);
            } catch (error) {
                console.error('[SettingsMemorySection] Failed to persist memory:', error);
                alertMessage.value?.error(
                    currentMode === 'draft'
                        ? t('settings.memory.createFailed')
                        : t('settings.memory.saveFailed'),
                    6000
                );
            } finally {
                saving.value = false;

                if (queuedAutosave.value) {
                    queuedAutosave.value = false;
                    if (
                        editorState.value &&
                        editorSignature.value !== lastHydratedSignature.value
                    ) {
                        scheduleAutosave();
                    }
                }
            }
        })();

        try {
            await persistPromise;
        } finally {
            persistPromise = null;
        }
    }

    async function handleDeleteMemory(id: number) {
        if (deletingIds.value.has(id)) {
            return;
        }

        deletingIds.value.add(id);
        const shouldResetSelectedEditor = selectedPersistedId.value === id;
        const remainingItems = sortedDirectoryItems.value.filter((item) => item.id !== id);

        try {
            const deleted = await deleteMemoryItem(id);
            if (!deleted) {
                throw new Error(`Memory ${id} not found.`);
            }

            removeDirectoryItem(id);

            if (!shouldResetSelectedEditor) {
                return;
            }

            const nextSelectedId = remainingItems[0]?.id;
            if (nextSelectedId) {
                await loadPersistedMemory(nextSelectedId);
            } else {
                resetEditor();
            }
        } catch (error) {
            console.error('[SettingsMemorySection] Failed to delete memory:', error);
            alertMessage.value?.error(t('settings.memory.deleteFailed'), 6000);
        } finally {
            deletingIds.value.delete(id);
        }
    }

    async function handleToggleEnabled(memoryId: number, enabled: boolean) {
        if (togglingIds.value.has(memoryId)) {
            return;
        }

        togglingIds.value.add(memoryId);

        try {
            const updated = await updateMemoryItem(memoryId, {
                enabled: enabled ? 1 : 0,
            });
            if (updated) {
                upsertDirectoryItem(updated);
            } else {
                updateDirectoryItemEnabled(memoryId, enabled ? 1 : 0);
            }
        } catch (error) {
            console.error('[SettingsMemorySection] Failed to toggle memory enabled:', error);
            alertMessage.value?.error(t('settings.memory.toggleFailed'), 6000);
        } finally {
            togglingIds.value.delete(memoryId);
        }
    }

    function handleMemoryContextMenu(id: number, event: MouseEvent) {
        openMemoryMenu(event, id);
    }

    function retryLoad() {
        void loadMemories();
    }

    onMounted(() => {
        void loadMemories();
    });

    onBeforeUnmount(() => {
        if (hasPendingCompleteAutosave()) {
            void flushPendingAutosave();
            return;
        }

        clearAutosaveTimer();
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div class="flex h-full bg-white">
        <div
            v-if="showLoadErrorState"
            data-testid="settings-memory-load-error"
            class="flex min-w-0 flex-1 flex-col bg-white"
        >
            <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
                <div>
                    <AppIcon name="x-circle" class="mx-auto h-12 w-12 text-neutral-300" />
                    <h3 class="mt-4 text-[15px] font-medium text-neutral-950">
                        {{ t('settings.memory.loadFailed') }}
                    </h3>
                </div>
            </div>

            <div class="px-6 pb-6">
                <button
                    type="button"
                    data-testid="settings-memory-retry-button"
                    class="settings-button-primary mx-auto flex w-full max-w-40 items-center justify-center gap-2 break-words whitespace-normal"
                    @click="retryLoad"
                >
                    <AppIcon name="refresh" class="h-4 w-4" />
                    {{ t('common.retry') }}
                </button>
            </div>
        </div>

        <div
            v-else-if="showEmptyWorkspace"
            data-testid="settings-memory-empty-workspace"
            class="flex min-w-0 flex-1 flex-col bg-white"
        >
            <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
                <div>
                    <AppIcon name="history" class="mx-auto h-12 w-12 text-neutral-300" />
                    <h3 class="mt-4 text-[15px] font-medium text-neutral-950">
                        {{ t('settings.memory.empty.title') }}
                    </h3>
                </div>
            </div>

            <div class="px-6 pb-6">
                <button
                    type="button"
                    data-testid="settings-memory-add-button"
                    class="settings-button-primary mx-auto flex w-full max-w-40 items-center justify-center gap-2 break-words whitespace-normal"
                    @click="openDraftEditor"
                >
                    <AppIcon name="plus" class="h-4 w-4" />
                    {{ t('settings.memory.actions.create') }}
                </button>
            </div>
        </div>

        <template v-else>
            <div
                v-if="showSidebar"
                class="settings-side-panel"
                :style="panelStyle"
                data-settings-secondary-panel="true"
                data-testid="settings-memory-panel"
            >
                <div class="settings-scrollbar flex-1 space-y-2 overflow-y-auto p-4 pt-5">
                    <div
                        v-for="item in sortedDirectoryItems"
                        :key="item.id"
                        :data-testid="`settings-memory-item-${item.id}`"
                        :class="[
                            'w-full cursor-pointer rounded-[11px] border px-3 py-2.5 text-left transition-colors',
                            selectedPersistedId === item.id
                                ? 'settings-item-selected'
                                : 'settings-item-unselected',
                        ]"
                        @click="handleSelectMemory(item.id)"
                        @contextmenu.prevent="handleMemoryContextMenu(item.id, $event)"
                    >
                        <div class="flex items-start justify-between gap-2">
                            <div class="min-w-0 flex-1">
                                <h3
                                    :class="[
                                        'truncate text-[13px] font-normal',
                                        item.enabled ? 'text-neutral-950' : 'text-neutral-500',
                                    ]"
                                >
                                    {{ item.title }}
                                </h3>
                                <p class="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">
                                    {{ item.applicability }}
                                </p>
                            </div>
                            <button
                                type="button"
                                :data-testid="`settings-memory-toggle-${item.id}`"
                                :disabled="togglingIds.has(item.id)"
                                :aria-pressed="Boolean(item.enabled)"
                                :class="[
                                    'relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                                    item.enabled ? 'bg-primary-700' : 'bg-neutral-200',
                                    togglingIds.has(item.id)
                                        ? 'cursor-not-allowed opacity-50'
                                        : 'cursor-pointer',
                                ]"
                                :title="t('settings.memory.toggleTitle')"
                                @click.stop="handleToggleEnabled(item.id, !item.enabled)"
                            >
                                <span
                                    :class="[
                                        'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                                        item.enabled ? 'translate-x-5' : 'translate-x-1',
                                    ]"
                                />
                            </button>
                        </div>
                    </div>
                </div>

                <div class="settings-side-panel-footer">
                    <button
                        type="button"
                        data-testid="settings-memory-add-button"
                        class="settings-button-primary flex w-full items-center justify-center gap-2 break-words whitespace-normal"
                        @click="openDraftEditor"
                    >
                        <AppIcon name="plus" class="h-4 w-4" />
                        {{ t('settings.memory.actions.create') }}
                    </button>
                </div>

                <div
                    data-testid="settings-memory-panel-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    :aria-valuemin="panelMinWidth"
                    :aria-valuemax="panelMaxWidth"
                    :aria-valuenow="panelWidth"
                    tabindex="0"
                    class="settings-side-panel-resizer"
                    :title="t('settings.memory.resizeList')"
                    @keydown="handleResizeKeyDown"
                    @pointerdown="handleResizePointerDown"
                />
            </div>

            <div class="flex min-w-0 flex-1 flex-col overflow-hidden bg-white">
                <div
                    ref="contentScrollRef"
                    class="settings-scrollbar min-h-0 flex-1 overflow-y-auto bg-white"
                >
                    <div v-if="editorState" class="settings-page-wide flex h-full min-h-0 flex-col">
                        <h1 class="settings-page-title mb-6 pt-8">{{ pageTitle }}</h1>

                        <div class="flex min-h-0 flex-1 flex-col gap-4">
                            <label class="block">
                                <span class="mb-1.5 block text-sm font-normal text-neutral-700">
                                    {{ t('settings.memory.field.title') }}
                                </span>
                                <input
                                    v-model="editorState.title"
                                    data-testid="settings-memory-title-input"
                                    class="settings-input w-full"
                                    :maxlength="TITLE_MAX_LENGTH"
                                    :placeholder="t('settings.memory.placeholder.title')"
                                />
                            </label>

                            <label class="block">
                                <span class="mb-1.5 block text-sm font-normal text-neutral-700">
                                    {{ t('settings.memory.field.applicability') }}
                                </span>
                                <input
                                    v-model="editorState.applicability"
                                    data-testid="settings-memory-applicability-input"
                                    class="settings-input w-full"
                                    :maxlength="APPLICABILITY_MAX_LENGTH"
                                    :placeholder="t('settings.memory.placeholder.applicability')"
                                />
                            </label>

                            <label class="flex min-h-0 flex-1 flex-col">
                                <span class="mb-1.5 block text-sm font-normal text-neutral-700">
                                    {{ t('settings.memory.field.content') }}
                                </span>
                                <textarea
                                    v-model="editorState.content"
                                    data-testid="settings-memory-content-input"
                                    class="settings-input min-h-[320px] flex-1 resize-none leading-6"
                                    :placeholder="t('settings.memory.placeholder.content')"
                                />
                            </label>
                        </div>
                    </div>

                    <div v-else class="flex h-full items-center justify-center px-6 text-center">
                        <div>
                            <AppIcon name="history" class="mx-auto h-12 w-12 text-neutral-300" />
                            <h3 class="mt-4 text-[15px] font-medium text-neutral-950">
                                {{ t('settings.memory.emptySelection.title') }}
                            </h3>
                        </div>
                    </div>
                </div>
            </div>
        </template>
    </div>
</template>
