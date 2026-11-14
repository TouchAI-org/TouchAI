<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import EmptyState from '@components/EmptyState.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import { native } from '@services/NativeService';
    import { log } from '@services/ObservabilityService';
    import { FocusScope } from 'reka-ui';
    import { computed, nextTick, ref, useId, watch } from 'vue';

    import { Button } from '@/components/ui/button';
    import { Input } from '@/components/ui/input';
    import { t } from '@/i18n';
    import {
        clampReasoningLevel,
        DEFAULT_REASONING_LEVEL,
        SELECTABLE_REASONING_LEVELS,
        type SelectableReasoningLevel,
    } from '@/services/AgentService/contracts/reasoning';
    import {
        formatShortcutForDisplay,
        matchShortcut,
        normalizeLocalShortcutString,
    } from '@/utils/shortcuts';
    import BadgedLogo from '@/views/SettingsView/components/AiServices/components/BadgedLogo.vue';

    import type { ModelDropdownData, ModelDropdownItem } from '../../types';
    import { filterModelDropdownItems } from '../../utils/modelSearch';

    defineOptions({ name: 'SearchModelDropdownOverlay' });

    const props = defineProps<{
        data: ModelDropdownData | null;
        onModelSelect?: (
            modelDbId: number,
            reasoningLevel?: SelectableReasoningLevel
        ) => void | Promise<void>;
        onSearchQueryChange?: (query: string) => void | Promise<void>;
    }>();
    const emit = defineEmits<{ close: [] }>();
    const pickerRef = ref<HTMLElement | null>(null);
    const searchInputRef = ref<InstanceType<typeof Input> | null>(null);
    const listId = useId();
    const localSearchQuery = ref(props.data?.searchQuery ?? '');
    const providerId = ref<number | null>(null);
    const highlightedIndex = ref(0);
    const selecting = ref(false);
    const selectionError = ref(false);
    const allModels = computed(() => props.data?.models ?? []);
    const providers = computed(() => [
        ...new Map(
            allModels.value.map((model) => [
                model.providerId,
                {
                    id: model.providerId,
                    name: model.providerName,
                    logo: model.providerLogo ?? '',
                },
            ])
        ).values(),
    ]);
    const models = computed(() =>
        filterModelDropdownItems(
            allModels.value.filter(
                (model) => providerId.value === null || model.providerId === providerId.value
            ),
            localSearchQuery.value
        )
    );
    const highlightedModel = computed(() => models.value[highlightedIndex.value]);
    const reasoningLevels = computed(() => highlightedModel.value?.reasoningLevels ?? []);
    const selectedLevel = computed(() =>
        highlightedModel.value ? levelForModel(highlightedModel.value) : undefined
    );
    const hasFilter = computed(
        () => Boolean(localSearchQuery.value.trim()) || providerId.value !== null
    );

    function isCurrent(model: ModelDropdownItem) {
        return (
            model.modelId === (props.data?.selectedModelId || props.data?.activeModelId) &&
            model.providerId === (props.data?.selectedProviderId ?? props.data?.activeProviderId)
        );
    }

    function levelForModel(model: ModelDropdownItem, requested?: SelectableReasoningLevel) {
        const levels = model.reasoningLevels ?? [];
        if (!levels.length) return undefined;
        const map = Object.fromEntries(
            SELECTABLE_REASONING_LEVELS.map((level) => [
                level,
                levels.includes(level) ? level : null,
            ])
        );
        return clampReasoningLevel(
            map,
            requested ??
                (isCurrent(model) ? props.data?.reasoningLevel : undefined) ??
                DEFAULT_REASONING_LEVEL
        );
    }

    function shortcutFor(index: number) {
        if (index > 8) return null;
        const shortcut = `Mod+${index + 1}`;
        const reserved = [...(props.data?.reservedShortcuts ?? []), props.data?.toggleShortcut];
        return reserved.some((value) => normalizeLocalShortcutString(value) === shortcut)
            ? null
            : shortcut;
    }

    async function handleSelect(model: ModelDropdownItem, level = levelForModel(model)) {
        if (selecting.value) return;
        selectionError.value = false;
        selecting.value = true;
        try {
            if (!props.onModelSelect) throw new Error('Model selection callback is unavailable');
            if (level === undefined) await props.onModelSelect(model.id);
            else await props.onModelSelect(model.id, level);
            emit('close');
        } catch (error) {
            selectionError.value = true;
            log.error('[SearchView] Failed to select model:', error);
        } finally {
            selecting.value = false;
        }
    }

    async function openSettingsFromEmptyState() {
        try {
            await native.window.openSettingsWindow();
            emit('close');
        } catch (error) {
            selectionError.value = true;
            log.error('[SearchView] Failed to open model settings:', error);
        }
    }

    async function handleSearchInput(query: string) {
        localSearchQuery.value = query;
        highlightedIndex.value = 0;
        try {
            await props.onSearchQueryChange?.(query);
        } catch (error) {
            localSearchQuery.value = props.data?.searchQuery ?? '';
            selectionError.value = true;
            log.error('[SearchView] Failed to search models:', error);
        }
    }

    function selectProvider(id: number | null) {
        providerId.value = id;
        highlightedIndex.value = 0;
    }

    async function scrollToHighlighted(moveFocus = false) {
        await nextTick();
        if (!highlightedModel.value) return;
        const row = pickerRef.value?.querySelector<HTMLElement>(
            `[data-model-id="${highlightedModel.value.id}"]`
        );
        if (moveFocus) row?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'nearest' });
    }

    function focusDepth(level?: SelectableReasoningLevel) {
        pickerRef.value?.querySelector<HTMLElement>(`[data-reasoning-level="${level}"]`)?.focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape' || matchShortcut(props.data?.toggleShortcut, event)) {
            event.preventDefault();
            emit('close');
            return;
        }
        if (selecting.value || (event.repeat && event.key === 'Enter')) return;
        const shortcutIndex = models.value.findIndex((_, index) =>
            matchShortcut(shortcutFor(index), event)
        );
        if (shortcutIndex !== -1) {
            event.preventDefault();
            if (!event.repeat) void handleSelect(models.value[shortcutIndex]!);
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        const target = event.target instanceof Element ? event.target : document.activeElement;
        const providerButton = target?.closest<HTMLElement>('[data-provider-id]');
        const depth = target?.closest<HTMLElement>('[data-reasoning-level]')?.dataset
            .reasoningLevel as SelectableReasoningLevel | undefined;
        if (providerButton) {
            const buttons = [
                ...(pickerRef.value?.querySelectorAll<HTMLElement>('[data-provider-id]') ?? []),
            ];
            const index = buttons.indexOf(providerButton);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next =
                    buttons[
                        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                            buttons.length
                    ];
                next?.click();
                next?.focus();
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                searchInputRef.value?.focus();
            }
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            if (depth) {
                const index = reasoningLevels.value.indexOf(depth);
                focusDepth(
                    reasoningLevels.value[
                        Math.max(0, Math.min(index + delta, reasoningLevels.value.length - 1))
                    ]
                );
            } else {
                highlightedIndex.value = Math.max(
                    0,
                    Math.min(highlightedIndex.value + delta, models.value.length - 1)
                );
                void scrollToHighlighted(Boolean(target?.closest('[data-model-id]')));
            }
        } else if (
            event.key === 'ArrowRight' &&
            reasoningLevels.value.length &&
            (!(target instanceof HTMLInputElement) || target.selectionStart === target.value.length)
        ) {
            event.preventDefault();
            focusDepth(selectedLevel.value);
        } else if (event.key === 'ArrowLeft' && depth) {
            event.preventDefault();
            searchInputRef.value?.focus();
        } else if (event.key === 'Enter' && highlightedModel.value) {
            event.preventDefault();
            void handleSelect(highlightedModel.value, depth ?? selectedLevel.value);
        }
    }

    function resetHighlight() {
        const current = models.value.findIndex(isCurrent);
        highlightedIndex.value = Math.max(current, 0);
    }
    function handleOverlayShown() {
        resetHighlight();
        searchInputRef.value?.focus();
        void scrollToHighlighted();
    }
    watch(
        () => props.data?.searchQuery,
        (value) => {
            if (value !== undefined) localSearchQuery.value = value;
        }
    );
    watch(() => models.value.map((model) => model.id).join(','), resetHighlight, {
        immediate: true,
    });
    watch(providers, (value) => {
        if (
            providerId.value !== null &&
            !value.some((provider) => provider.id === providerId.value)
        )
            providerId.value = null;
    });
    defineExpose({ handleOverlayShown, handleKeyDown });
</script>

<template>
    <FocusScope as-child loop @mount-auto-focus.prevent @unmount-auto-focus.prevent>
        <div
            ref="pickerRef"
            data-model-dropdown-popover="true"
            data-search-controls="true"
            role="dialog"
            :aria-label="t('search.toolbar.selectModel')"
            class="model-dropdown-popover search-surface-elevated flex h-96 w-160 flex-col overflow-hidden text-foreground"
            :style="{
                maxHeight: 'var(--search-overlay-max-height, 24rem)',
                maxWidth: 'var(--search-overlay-max-width, 40rem)',
            }"
            @keydown="handleKeyDown"
        >
            <div class="flex min-h-0 flex-1">
                <div
                    class="custom-scrollbar-thin flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border px-1 py-2"
                    role="toolbar"
                    aria-orientation="vertical"
                    :aria-label="t('popup.modelDropdown.providers')"
                >
                    <Button
                        variant="toolbar"
                        size="icon"
                        data-provider-id="all"
                        :aria-label="t('popup.modelDropdown.allProviders')"
                        :title="t('popup.modelDropdown.allProviders')"
                        :aria-pressed="providerId === null"
                        :tabindex="providerId === null ? 0 : -1"
                        @click="selectProvider(null)"
                    >
                        <AppIcon name="grid-alt" class="size-5" />
                    </Button>
                    <div class="my-1 w-7 border-t border-border" />
                    <Button
                        v-for="provider in providers"
                        :key="provider.id"
                        variant="toolbar"
                        size="icon"
                        :data-provider-id="provider.id"
                        :aria-label="provider.name"
                        :title="provider.name"
                        :aria-pressed="providerId === provider.id"
                        :tabindex="providerId === provider.id ? 0 : -1"
                        :disabled="selecting"
                        @click="selectProvider(provider.id)"
                    >
                        <BadgedLogo :logo="provider.logo" :name="provider.name" />
                    </Button>
                </div>
                <div class="flex min-w-0 flex-1 flex-col">
                    <div class="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
                        <AppIcon name="search" class="size-4 shrink-0 text-muted-foreground" />
                        <Input
                            ref="searchInputRef"
                            variant="search"
                            :model-value="localSearchQuery"
                            :placeholder="t('popup.modelDropdown.searchPlaceholder')"
                            :aria-label="t('popup.modelDropdown.searchPlaceholder')"
                            role="combobox"
                            aria-expanded="true"
                            aria-autocomplete="list"
                            :aria-controls="listId"
                            :aria-activedescendant="
                                highlightedModel ? `${listId}-${highlightedModel.id}` : undefined
                            "
                            @update:model-value="handleSearchInput"
                        />
                    </div>
                    <div
                        :id="listId"
                        class="custom-scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2"
                        role="listbox"
                        :aria-label="t('search.toolbar.selectModel')"
                    >
                        <Button
                            v-for="(model, index) in models"
                            :id="`${listId}-${model.id}`"
                            :key="model.id"
                            variant="picker"
                            size="sm"
                            role="option"
                            :data-model-id="model.id"
                            :data-highlighted="index === highlightedIndex"
                            :aria-selected="isCurrent(model)"
                            :tabindex="index === highlightedIndex ? 0 : -1"
                            :title="`${model.name} · ${model.providerName}`"
                            :disabled="selecting"
                            @mouseenter="highlightedIndex = index"
                            @focus="highlightedIndex = index"
                            @click="handleSelect(model)"
                        >
                            <ModelLogo
                                :model-id="model.modelId"
                                :name="model.name"
                                size="sm"
                                class="shrink-0"
                            />
                            <span
                                class="min-w-0 flex-1 truncate text-left"
                                data-no-i18n="true"
                                translate="no"
                            >
                                {{ model.name }}
                                <span class="text-muted-foreground">
                                    · {{ model.providerName }}
                                </span>
                            </span>
                            <span
                                v-if="
                                    model.modelId === data?.activeModelId &&
                                    model.providerId === data?.activeProviderId
                                "
                                class="model-dropdown-state-badge shrink-0 text-2xs whitespace-nowrap text-muted-foreground"
                            >
                                {{ t('common.default') }}
                            </span>
                            <kbd
                                v-if="shortcutFor(index)"
                                class="shrink-0 rounded-sm bg-surface-sunken px-1 text-2xs font-normal text-muted-foreground"
                            >
                                {{ formatShortcutForDisplay(shortcutFor(index)) }}
                            </kbd>
                            <AppIcon
                                v-if="isCurrent(model)"
                                name="check"
                                class="size-3.5 shrink-0"
                                :aria-label="t('common.current')"
                            />
                        </Button>
                        <EmptyState
                            v-if="models.length === 0"
                            :title="
                                t(
                                    hasFilter
                                        ? 'popup.modelDropdown.empty.noMatches'
                                        : 'popup.modelDropdown.empty.noModels'
                                )
                            "
                            :icon="hasFilter ? 'search' : 'database'"
                            size="compact"
                        >
                            <template #description>
                                <span v-if="hasFilter">
                                    {{ t('popup.modelDropdown.empty.tryShorter') }}
                                </span>
                                <span v-else>
                                    {{ t('popup.modelDropdown.emptySetupPrefix') }}
                                    <Button
                                        variant="link"
                                        size="sm"
                                        @click="openSettingsFromEmptyState"
                                    >
                                        {{ t('popup.modelDropdown.settingsCenter') }}
                                    </Button>
                                    {{ t('popup.modelDropdown.emptySetupSuffix') }}
                                </span>
                            </template>
                        </EmptyState>
                    </div>
                </div>
                <div class="flex w-36 shrink-0 flex-col border-l border-border">
                    <div class="flex h-12 shrink-0 items-center px-3 text-xs text-muted-foreground">
                        {{ t('popup.modelDropdown.reasoning') }}
                    </div>
                    <div
                        class="custom-scrollbar-thin min-h-0 overflow-y-auto px-2 pb-2"
                        role="radiogroup"
                        :aria-label="t('popup.modelDropdown.reasoning')"
                    >
                        <Button
                            v-for="level in reasoningLevels"
                            :key="level"
                            variant="picker"
                            size="sm"
                            role="radio"
                            :data-reasoning-level="level"
                            :aria-checked="selectedLevel === level"
                            :tabindex="selectedLevel === level ? 0 : -1"
                            :disabled="selecting"
                            @click="highlightedModel && handleSelect(highlightedModel, level)"
                        >
                            <span class="flex-1 text-left">
                                {{ t(`popup.modelDropdown.level.${level}`) }}
                            </span>
                            <AppIcon
                                v-if="selectedLevel === level"
                                name="check"
                                class="size-3.5 shrink-0"
                            />
                        </Button>
                        <p
                            v-if="!reasoningLevels.length"
                            class="px-1 py-2 text-xs text-muted-foreground"
                        >
                            {{ t('popup.modelDropdown.reasoningUnavailable') }}
                        </p>
                    </div>
                </div>
            </div>
            <p
                v-if="selectionError"
                role="alert"
                class="border-t border-border px-3 py-2 text-xs text-text-danger"
            >
                {{ t('popup.modelDropdown.selectFailed') }}
            </p>
        </div>
    </FocusScope>
</template>
