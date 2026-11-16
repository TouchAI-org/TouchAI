<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import EmptyState from '@components/EmptyState.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import {
        DropdownMenu,
        DropdownMenuContent,
        DropdownMenuItem,
        DropdownMenuTrigger,
    } from '@components/ui/dropdown-menu';
    import { native } from '@services/NativeService';
    import { log } from '@services/ObservabilityService';
    import { FocusScope } from 'reka-ui';
    import { computed, nextTick, ref, useId, watch } from 'vue';

    import { Button } from '@/components/ui/button';
    import { Input } from '@/components/ui/input';
    import { type MessageKey, t } from '@/i18n';
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
    import {
        filterModelDropdownItems,
        type ModelDropdownSortKey,
        sortModelDropdownItems,
    } from '../../utils/modelSearch';

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
    const modelListRef = ref<HTMLElement | null>(null);
    const searchInputRef = ref<InstanceType<typeof Input> | null>(null);
    const listId = useId();
    const localSearchQuery = ref(props.data?.searchQuery ?? '');
    const sortKey = ref<ModelDropdownSortKey | null>(null);
    const sortAscending = ref(true);
    const highlightedIndex = ref(0);
    const selecting = ref(false);
    const selectionError = ref(false);
    const sortOptions: Array<{ key: ModelDropdownSortKey; labelKey: MessageKey }> = [
        { key: 'name', labelKey: 'popup.modelDropdown.sort.name' },
        { key: 'vendor', labelKey: 'popup.modelDropdown.sort.vendor' },
        { key: 'provider', labelKey: 'popup.modelDropdown.sort.provider' },
    ];
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
    const models = computed(() => {
        const filtered = filterModelDropdownItems(allModels.value, localSearchQuery.value);
        return sortKey.value
            ? sortModelDropdownItems(filtered, sortKey.value, sortAscending.value)
            : filtered;
    });
    const highlightedModel = computed(() => models.value[highlightedIndex.value]);
    const reasoningLevels = computed(() => highlightedModel.value?.reasoningLevels ?? []);
    const selectedLevel = computed(() =>
        highlightedModel.value ? levelForModel(highlightedModel.value) : undefined
    );
    const hasFilter = computed(() => Boolean(localSearchQuery.value.trim()));

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

    function setSortKey(key: ModelDropdownSortKey) {
        sortKey.value = key;
        highlightedIndex.value = 0;
    }

    function toggleSortDirection() {
        if (!sortKey.value) return;
        sortAscending.value = !sortAscending.value;
        highlightedIndex.value = 0;
    }

    async function scrollToProvider(providerId: number | null) {
        const index =
            providerId === null
                ? 0
                : models.value.findIndex((model) => model.providerId === providerId);
        if (index < 0) return;
        highlightedIndex.value = index;
        await nextTick();
        modelListRef.value
            ?.querySelector<HTMLElement>(`[data-model-id="${models.value[index]!.id}"]`)
            ?.scrollIntoView({ block: 'start' });
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
        const depth = target?.closest<HTMLElement>('[data-reasoning-level]')?.dataset
            .reasoningLevel as SelectableReasoningLevel | undefined;
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
            class="model-dropdown-popover search-surface-elevated flex h-96 w-128 flex-col overflow-hidden text-foreground"
            :style="{
                maxHeight: 'var(--search-overlay-max-height, 24rem)',
                maxWidth: 'var(--search-overlay-max-width, 32rem)',
            }"
            @keydown="handleKeyDown"
        >
            <div class="flex min-h-0 flex-1">
                <nav
                    class="custom-scrollbar-thin flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border px-1 py-2"
                    :aria-label="t('popup.modelDropdown.providers')"
                >
                    <Button
                        variant="rail"
                        size="icon"
                        data-provider-index="all"
                        :aria-label="t('popup.modelDropdown.allProviders')"
                        :title="t('popup.modelDropdown.allProviders')"
                        @click="scrollToProvider(null)"
                    >
                        <AppIcon name="grid-alt" class="size-5" />
                    </Button>
                    <div class="my-1 w-7 border-t border-border" />
                    <Button
                        v-for="provider in providers"
                        :key="provider.id"
                        variant="rail"
                        size="icon"
                        :data-provider-index="provider.id"
                        :aria-label="provider.name"
                        :title="provider.name"
                        :aria-current="
                            highlightedModel?.providerId === provider.id ? 'true' : undefined
                        "
                        :data-current="highlightedModel?.providerId === provider.id"
                        :disabled="selecting"
                        @click="scrollToProvider(provider.id)"
                    >
                        <BadgedLogo :logo="provider.logo" :name="provider.name" />
                    </Button>
                </nav>
                <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                    <div
                        class="relative flex h-12 shrink-0 items-center gap-1 border-b border-border px-3"
                    >
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
                        <DropdownMenu>
                            <DropdownMenuTrigger as-child>
                                <Button
                                    variant="toolbar"
                                    size="icon-sm"
                                    data-sort-trigger="true"
                                    :aria-label="t('popup.modelDropdown.sortTitle')"
                                    :title="t('popup.modelDropdown.sortTitle')"
                                >
                                    <AppIcon name="sort" class="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                disable-portal
                                align="end"
                                data-search-controls="true"
                                class="min-w-44 p-1"
                            >
                                <DropdownMenuItem
                                    v-for="option in sortOptions"
                                    :key="option.key"
                                    :data-sort-field="option.key"
                                    class="rounded-sm px-2 py-1.5"
                                    @select="setSortKey(option.key)"
                                >
                                    <AppIcon
                                        name="check"
                                        class="size-3.5 shrink-0"
                                        :class="sortKey === option.key ? '' : 'invisible'"
                                    />
                                    {{ t(option.labelKey) }}
                                </DropdownMenuItem>
                                <div class="my-1 border-t border-border"></div>
                                <DropdownMenuItem
                                    data-sort-direction="true"
                                    :disabled="sortKey === null"
                                    class="rounded-sm px-2 py-1.5"
                                    @select="toggleSortDirection"
                                >
                                    <AppIcon
                                        :name="sortAscending ? 'chevron-up' : 'chevron-down'"
                                        class="size-3.5 shrink-0"
                                    />
                                    {{
                                        t(
                                            sortAscending
                                                ? 'popup.modelDropdown.sort.ascending'
                                                : 'popup.modelDropdown.sort.descending'
                                        )
                                    }}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                    <div
                        :id="listId"
                        ref="modelListRef"
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
            </div>
            <div class="shrink-0 border-t border-border px-3 py-2.5">
                <div class="mb-2 flex min-w-0 items-center justify-between gap-3 text-xs">
                    <span class="shrink-0 text-muted-foreground">
                        {{ t('popup.modelDropdown.reasoning') }}
                    </span>
                    <span
                        v-if="highlightedModel"
                        class="min-w-0 truncate font-medium text-foreground"
                    >
                        {{ highlightedModel.name }}
                    </span>
                </div>
                <div
                    v-if="reasoningLevels.length"
                    class="flex flex-wrap gap-1 rounded-lg bg-surface-sunken p-1"
                    role="radiogroup"
                    :aria-label="t('popup.modelDropdown.reasoning')"
                >
                    <Button
                        v-for="level in reasoningLevels"
                        :key="level"
                        variant="segment"
                        size="sm"
                        role="radio"
                        :data-reasoning-level="level"
                        :aria-checked="selectedLevel === level"
                        :tabindex="selectedLevel === level ? 0 : -1"
                        :disabled="selecting"
                        class="min-w-16 flex-1 px-2 text-xs"
                        @click="highlightedModel && handleSelect(highlightedModel, level)"
                    >
                        <span class="truncate">
                            {{ t(`popup.modelDropdown.level.${level}`) }}
                        </span>
                    </Button>
                </div>
                <p v-else class="px-1 py-1 text-xs text-muted-foreground">
                    {{ t('popup.modelDropdown.reasoningUnavailable') }}
                </p>
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
