<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import AppIcon from '@components/AppIcon.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import {
        createMemoryItem,
        findMemoryDirectoryItems,
        readMemoryItemsByIds,
        updateMemoryItem,
    } from '@database/queries/memoryItems';
    import type { MemoryDirectoryItemEntity, MemoryItemEntity } from '@database/types';
    import { computed, onMounted, ref } from 'vue';

    import { t } from '@/i18n';

    import { useSettingsResizablePanel } from '../../composables/useSettingsResizablePanel';

    defineOptions({
        name: 'SettingsMemorySection',
    });

    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const {
        handleResizeKeyDown,
        handleResizePointerDown,
        panelMaxWidth,
        panelMinWidth,
        panelStyle,
        panelWidth,
    } = useSettingsResizablePanel();
    const loading = ref(true);
    const loadError = ref(false);
    const saving = ref(false);
    const creating = ref(false);
    const togglingMemoryIds = ref<Set<number>>(new Set());
    const pendingMemoryEnabledById = ref<Map<number, number>>(new Map());
    const directoryItems = ref<MemoryDirectoryItemEntity[]>([]);
    const selectedMemory = ref<MemoryItemEntity | null>(null);
    const contentScrollRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(contentScrollRef);

    const sortedDirectoryItems = computed(() =>
        [...directoryItems.value].sort(compareMemoryDirectoryItems)
    );
    const selectedDirectoryItem = computed(() =>
        directoryItems.value.find((item) => item.id === selectedMemory.value?.id)
    );
    const hasMemories = computed(() => sortedDirectoryItems.value.length > 0);
    const showEmptyWorkspace = computed(
        () => !loading.value && !loadError.value && !hasMemories.value
    );

    function validateSelectedMemory(): string | null {
        if (!selectedMemory.value?.title.trim()) {
            return t('settings.memory.validation.titleRequired');
        }
        if (!selectedMemory.value.applicability.trim()) {
            return t('settings.memory.validation.applicabilityRequired');
        }
        if (!selectedMemory.value.content.trim()) {
            return t('settings.memory.validation.contentRequired');
        }
        return null;
    }

    function compareMemoryDirectoryItems(
        left: MemoryDirectoryItemEntity,
        right: MemoryDirectoryItemEntity
    ): number {
        return (
            Number(right.enabled) - Number(left.enabled) ||
            String(right.updated_at).localeCompare(String(left.updated_at)) ||
            right.id - left.id
        );
    }

    function toDirectoryItem(memory: MemoryItemEntity): MemoryDirectoryItemEntity {
        return {
            id: memory.id,
            title: memory.title,
            applicability: memory.applicability,
            enabled: memory.enabled,
            updated_at: memory.updated_at,
        };
    }

    function upsertLocalMemory(memory: MemoryItemEntity) {
        const nextItem = toDirectoryItem(memory);
        const existingIndex = directoryItems.value.findIndex((item) => item.id === memory.id);

        if (existingIndex === -1) {
            directoryItems.value = [nextItem, ...directoryItems.value];
        } else {
            directoryItems.value = directoryItems.value.map((item) =>
                item.id === memory.id ? nextItem : item
            );
        }

        selectedMemory.value = memory;
    }

    function updateLocalMemoryEnabled(
        memoryId: number,
        enabled: number,
        timestamps?: Pick<MemoryItemEntity, 'updated_at' | 'last_used_at'>
    ) {
        directoryItems.value = directoryItems.value.map((memory) =>
            memory.id === memoryId
                ? {
                      ...memory,
                      enabled,
                      updated_at: timestamps?.updated_at ?? memory.updated_at,
                  }
                : memory
        );

        if (selectedMemory.value?.id === memoryId) {
            selectedMemory.value = {
                ...selectedMemory.value,
                enabled,
                updated_at: timestamps?.updated_at ?? selectedMemory.value.updated_at,
                last_used_at: timestamps?.last_used_at ?? selectedMemory.value.last_used_at,
            };
        }
    }

    function getPendingMemoryEnabled(memoryId: number): number | undefined {
        return pendingMemoryEnabledById.value.get(memoryId);
    }

    function setPendingMemoryEnabled(memoryId: number, enabled: number) {
        const nextPending = new Map(pendingMemoryEnabledById.value);
        nextPending.set(memoryId, enabled);
        pendingMemoryEnabledById.value = nextPending;
    }

    function clearPendingMemoryEnabled(memoryId: number) {
        const nextPending = new Map(pendingMemoryEnabledById.value);
        nextPending.delete(memoryId);
        pendingMemoryEnabledById.value = nextPending;
    }

    function applyPendingMemoryEnabled<T extends MemoryDirectoryItemEntity | MemoryItemEntity>(
        memory: T
    ): T {
        const pendingEnabled = getPendingMemoryEnabled(memory.id);
        return pendingEnabled === undefined
            ? memory
            : {
                  ...memory,
                  enabled: pendingEnabled,
              };
    }

    async function selectMemory(id: number) {
        try {
            const [memory] = await readMemoryItemsByIds([id]);
            selectedMemory.value = memory ? applyPendingMemoryEnabled(memory) : null;
        } catch (error) {
            console.error('[SettingsMemorySection] Failed to load memory:', error);
            alertMessage.value?.error(t('settings.memory.loadFailed'), 6000);
        }
    }

    async function loadMemories(preferredSelectedId?: number) {
        loading.value = true;
        try {
            const items = await findMemoryDirectoryItems();
            const visibleItems = items.map(applyPendingMemoryEnabled);
            directoryItems.value = visibleItems;
            loadError.value = false;
            const orderedItems = [...visibleItems].sort(compareMemoryDirectoryItems);
            const nextSelectedId =
                preferredSelectedId && visibleItems.some((item) => item.id === preferredSelectedId)
                    ? preferredSelectedId
                    : selectedMemory.value &&
                        visibleItems.some((item) => item.id === selectedMemory.value?.id)
                      ? selectedMemory.value.id
                      : orderedItems[0]?.id;

            if (nextSelectedId) {
                await selectMemory(nextSelectedId);
            } else {
                selectedMemory.value = null;
            }
        } catch (error) {
            console.error('[SettingsMemorySection] Failed to load memories:', error);
            loadError.value = true;
            alertMessage.value?.error(t('settings.memory.loadFailed'), 6000);
        } finally {
            loading.value = false;
        }
    }

    async function createMemory() {
        if (creating.value) {
            return;
        }

        creating.value = true;
        try {
            const created = await createMemoryItem({
                title: t('settings.memory.createDefaultTitle'),
                applicability: t('settings.memory.createDefaultApplicability'),
                content: t('settings.memory.createDefaultContent'),
                enabled: 0,
            });
            upsertLocalMemory(created);
            await loadMemories(created.id);
        } catch (error) {
            console.error('[SettingsMemorySection] Failed to create memory:', error);
            alertMessage.value?.error(t('settings.memory.createFailed'), 6000);
        } finally {
            creating.value = false;
        }
    }

    async function saveSelectedMemory() {
        if (!selectedMemory.value || saving.value) {
            return;
        }

        const validationError = validateSelectedMemory();
        if (validationError) {
            alertMessage.value?.error(validationError, 4000);
            return;
        }

        saving.value = true;
        try {
            const memoryId = selectedMemory.value.id;
            const updated = await updateMemoryItem(memoryId, {
                title: selectedMemory.value.title,
                applicability: selectedMemory.value.applicability,
                content: selectedMemory.value.content,
            });
            if (updated && selectedMemory.value?.id === memoryId) {
                selectedMemory.value = {
                    ...updated,
                    enabled: selectedMemory.value.enabled,
                };
            }
            await loadMemories();
            alertMessage.value?.success(t('settings.memory.saved'), 3000);
        } catch (error) {
            console.error('[SettingsMemorySection] Failed to save memory:', error);
            alertMessage.value?.error(t('settings.memory.saveFailed'), 6000);
        } finally {
            saving.value = false;
        }
    }

    async function toggleMemoryEnabled(item: MemoryDirectoryItemEntity, enabled: boolean) {
        if (togglingMemoryIds.value.has(item.id)) {
            return;
        }

        const nextEnabled = enabled ? 1 : 0;
        const previousDirectoryItem = directoryItems.value.find((memory) => memory.id === item.id);
        const previousSelectedState =
            selectedMemory.value?.id === item.id
                ? {
                      enabled: selectedMemory.value.enabled,
                      updated_at: selectedMemory.value.updated_at,
                      last_used_at: selectedMemory.value.last_used_at,
                  }
                : null;

        togglingMemoryIds.value.add(item.id);
        setPendingMemoryEnabled(item.id, nextEnabled);
        updateLocalMemoryEnabled(item.id, nextEnabled);
        try {
            const updated = await updateMemoryItem(item.id, {
                enabled: nextEnabled,
            });
            if (!updated) {
                throw new Error(`Memory item not found after enabled update: ${item.id}`);
            }

            directoryItems.value = directoryItems.value.map((memory) =>
                memory.id === item.id
                    ? {
                          id: updated.id,
                          title: updated.title,
                          applicability: updated.applicability,
                          enabled: updated.enabled,
                          updated_at: updated.updated_at,
                      }
                    : memory
            );

            updateLocalMemoryEnabled(item.id, updated.enabled, {
                updated_at: updated.updated_at,
                last_used_at: updated.last_used_at,
            });
            clearPendingMemoryEnabled(item.id);
        } catch (error) {
            clearPendingMemoryEnabled(item.id);
            if (previousDirectoryItem) {
                directoryItems.value = directoryItems.value.map((memory) =>
                    memory.id === item.id ? previousDirectoryItem : memory
                );
            }

            if (previousSelectedState && selectedMemory.value?.id === item.id) {
                selectedMemory.value = {
                    ...selectedMemory.value,
                    ...previousSelectedState,
                };
            }
            console.error('[SettingsMemorySection] Failed to toggle memory:', error);
            alertMessage.value?.error(t('settings.memory.toggleFailed'), 6000);
        } finally {
            togglingMemoryIds.value.delete(item.id);
        }
    }

    onMounted(() => {
        void loadMemories();
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div class="flex h-full bg-white">
        <div
            v-if="showEmptyWorkspace"
            data-testid="settings-memory-empty-workspace"
            class="flex min-w-0 flex-1 flex-col"
        >
            <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
                <div>
                    <AppIcon name="history" class="mx-auto h-12 w-12 text-neutral-300" />
                    <h3 class="mt-4 text-[15px] font-medium text-neutral-950">
                        {{ t('settings.memory.empty.title') }}
                    </h3>
                </div>
            </div>

            <div class="border-t border-neutral-200/80 bg-white px-6 py-4">
                <button
                    data-testid="settings-memory-create"
                    class="settings-button-primary mx-auto block w-full max-w-40"
                    :disabled="creating"
                    @click="createMemory"
                >
                    {{ t('settings.memory.actions.create') }}
                </button>
            </div>
        </div>

        <template v-else>
            <div
                class="settings-side-panel"
                :style="panelStyle"
                data-settings-secondary-panel="true"
                data-testid="settings-memory-panel"
            >
                <div class="settings-scrollbar flex-1 space-y-1 overflow-y-auto p-4 pt-5">
                    <div v-if="loading" class="flex h-full min-h-40 items-center justify-center">
                        <div
                            class="border-t-primary-700 h-8 w-8 animate-spin rounded-full border-2 border-neutral-200"
                        />
                    </div>

                    <template v-else>
                        <div
                            v-for="item in sortedDirectoryItems"
                            :key="item.id"
                            :data-testid="`settings-memory-item-${item.id}`"
                            :class="[
                                'w-full cursor-pointer rounded-[11px] border px-3 py-2.5 text-left transition-colors',
                                selectedMemory?.id === item.id
                                    ? 'settings-item-selected'
                                    : 'settings-item-unselected',
                                item.enabled ? '' : 'opacity-70',
                            ]"
                            @click="selectMemory(item.id)"
                        >
                            <div class="flex items-start justify-between gap-2">
                                <div class="min-w-0 flex-1">
                                    <h3 class="truncate text-[13px] font-normal text-neutral-950">
                                        {{ item.title }}
                                    </h3>
                                    <p class="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">
                                        {{ item.applicability }}
                                    </p>
                                </div>
                                <button
                                    :data-testid="`settings-memory-toggle-${item.id}`"
                                    :disabled="togglingMemoryIds.has(item.id)"
                                    :aria-pressed="Boolean(item.enabled)"
                                    :class="[
                                        'relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                                        item.enabled ? 'bg-primary-700' : 'bg-neutral-200',
                                        togglingMemoryIds.has(item.id)
                                            ? 'cursor-not-allowed opacity-50'
                                            : 'cursor-pointer',
                                    ]"
                                    :title="t('settings.memory.toggleTitle')"
                                    @click.stop="toggleMemoryEnabled(item, !item.enabled)"
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
                    </template>
                </div>

                <div class="settings-side-panel-footer">
                    <button
                        data-testid="settings-memory-create"
                        class="settings-button-primary w-full"
                        :disabled="creating"
                        @click="createMemory"
                    >
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

            <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
                <div
                    ref="contentScrollRef"
                    data-testid="settings-memory-content"
                    class="settings-scrollbar min-h-0 flex-1 overflow-y-auto bg-white"
                >
                    <div v-if="selectedMemory" class="settings-page-wide">
                        <div class="border-b border-neutral-200/80 pb-5">
                            <div class="flex items-start justify-between gap-4">
                                <div class="min-w-0">
                                    <h1 class="settings-page-title truncate">
                                        {{ selectedDirectoryItem?.title ?? selectedMemory.title }}
                                    </h1>
                                    <p class="mt-1 text-xs text-neutral-500">
                                        {{
                                            t('settings.memory.updatedAt', {
                                                time: selectedMemory.updated_at,
                                            })
                                        }}
                                    </p>
                                </div>
                                <span
                                    :class="[
                                        'mt-0.5 rounded-full px-2.5 py-1 text-xs font-medium',
                                        selectedMemory.enabled
                                            ? 'bg-primary-50 text-primary-700 ring-primary-100 ring-1'
                                            : 'bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200',
                                    ]"
                                >
                                    {{
                                        selectedMemory.enabled
                                            ? t('common.enabled')
                                            : t('common.disabled')
                                    }}
                                </span>
                            </div>
                        </div>

                        <div class="space-y-5 pt-5">
                            <label class="block">
                                <span class="text-sm font-normal text-neutral-700">
                                    {{ t('settings.memory.field.title') }}
                                </span>
                                <input
                                    v-model="selectedMemory.title"
                                    class="settings-input mt-1.5 w-full"
                                />
                            </label>

                            <label class="block">
                                <span class="text-sm font-normal text-neutral-700">
                                    {{ t('settings.memory.field.applicability') }}
                                </span>
                                <textarea
                                    v-model="selectedMemory.applicability"
                                    rows="3"
                                    class="settings-input mt-1.5 w-full resize-none leading-6"
                                />
                            </label>

                            <label class="block">
                                <span class="text-sm font-normal text-neutral-700">
                                    {{ t('settings.memory.field.content') }}
                                </span>
                                <textarea
                                    v-model="selectedMemory.content"
                                    rows="10"
                                    class="settings-input mt-1.5 w-full resize-y leading-6"
                                />
                            </label>

                            <div class="flex justify-end">
                                <button
                                    data-testid="settings-memory-save"
                                    class="settings-button-primary"
                                    :disabled="saving"
                                    @click="saveSelectedMemory"
                                >
                                    {{ t('common.save') }}
                                </button>
                            </div>
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
