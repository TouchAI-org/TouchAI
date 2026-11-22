<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<template>
    <div
        ref="rootRef"
        data-testid="prompt-snippet-picker"
        class="search-surface-elevated flex max-h-96 w-80 flex-col overflow-hidden outline-none"
        :style="{
            maxHeight: 'min(24rem, var(--search-overlay-max-height, 24rem))',
            maxWidth: 'var(--search-overlay-max-width, 20rem)',
        }"
        tabindex="-1"
        role="dialog"
        :aria-label="t('settings.general.promptSnippets.title')"
    >
        <header
            class="flex shrink-0 items-center justify-between gap-3 border-b border-search-border px-3 py-2.5"
        >
            <div class="flex min-w-0 items-center gap-2">
                <AppIcon name="terminal" class="h-4 w-4 shrink-0 text-search-muted" />
                <span class="truncate text-xs font-medium text-search-text">
                    {{ t('settings.general.promptSnippets.title') }}
                </span>
            </div>
            <span
                class="shrink-0 rounded-full bg-search-hover px-2 py-1 text-caption text-search-muted"
            >
                {{ insertionModeLabel }}
            </span>
        </header>

        <div
            v-if="storageBlocked"
            data-testid="prompt-snippet-picker-storage-error"
            role="alert"
            class="px-4 py-8 text-sm leading-6 text-text-secondary"
        >
            {{ storageMessage }}
        </div>

        <template v-else>
            <div
                v-if="storageNotice"
                data-testid="prompt-snippet-picker-storage-warning"
                role="status"
                class="shrink-0 border-b border-search-border px-3 py-2 text-caption text-text-secondary"
            >
                {{ storageNotice }}
            </div>

            <div
                v-if="visibleItems.length === 0"
                data-testid="prompt-snippet-picker-empty"
                class="min-h-0 overflow-y-auto px-2"
            >
                <EmptyState
                    :title="t('settings.general.promptSnippets.empty')"
                    :description="t('settings.general.promptSnippets.description')"
                    icon="terminal"
                    size="compact"
                />
            </div>

            <div
                v-else
                class="custom-scrollbar-thin min-h-0 overflow-y-auto px-2 py-2"
                role="listbox"
                :aria-label="t('settings.general.promptSnippets.title')"
            >
                <button
                    v-for="(item, index) in visibleItems"
                    :key="item.id"
                    :ref="
                        (element) => {
                            if (element) itemRefs[index] = element as HTMLElement;
                        }
                    "
                    type="button"
                    role="option"
                    :aria-selected="index === highlightedIndex"
                    :data-prompt-snippet-id="item.id"
                    :data-prompt-snippet-index="index < 9 ? index + 1 : undefined"
                    class="flex w-full cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-search-hover"
                    :class="{
                        'bg-search-hover': index === highlightedIndex,
                    }"
                    @mouseenter="highlightedIndex = index"
                    @click="handleSelect(index)"
                >
                    <span
                        class="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-keycap px-1 text-caption font-medium text-keycap-foreground"
                        aria-hidden="true"
                    >
                        {{ index < 9 ? index + 1 : '' }}
                    </span>
                    <span class="min-w-0 flex-1">
                        <span class="flex min-w-0 items-center gap-1.5">
                            <span
                                class="truncate text-xs font-medium text-search-text"
                                data-no-i18n="true"
                                translate="no"
                            >
                                {{ item.title }}
                            </span>
                            <AppIcon
                                v-if="item.isFavorite"
                                name="pin"
                                class="h-3 w-3 shrink-0 text-search-match"
                                :aria-label="t('settings.general.promptSnippets.favoriteBadge')"
                            />
                        </span>
                        <span
                            class="mt-1 line-clamp-2 text-caption break-words whitespace-pre-wrap text-search-muted"
                            data-no-i18n="true"
                            translate="no"
                        >
                            {{ item.body }}
                        </span>
                    </span>
                </button>
            </div>

            <p
                v-if="selectionFailed"
                role="alert"
                class="shrink-0 border-t border-search-border px-3 py-2 text-caption text-text-danger"
            >
                {{ t('settings.general.promptSnippets.operationFailed') }}
            </p>

            <footer
                class="flex shrink-0 items-center justify-between gap-3 border-t border-search-border px-3 py-2 text-caption text-search-muted"
            >
                <span>1–9 · ↑↓ · Enter · Esc</span>
                <span v-if="visibleItems.length > 9">{{ visibleItems.length }}</span>
            </footer>
        </template>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import EmptyState from '@components/EmptyState.vue';
    import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

    import {
        canWritePromptSnippetStorage,
        PROMPT_SNIPPET_MAX_ITEMS,
        sortPromptSnippets,
    } from '@/app/api/settings/preferences';
    import { t } from '@/i18n';
    import { matchShortcut } from '@/utils/shortcuts';

    import type { PromptSnippet, PromptSnippetPickerData } from './types';

    defineOptions({
        name: 'PromptSnippetPicker',
    });

    const props = defineProps<{
        data: PromptSnippetPickerData | null;
        onSelect?: (snippet: PromptSnippet) => void | Promise<void>;
    }>();

    const emit = defineEmits<{
        close: [];
    }>();

    const rootRef = ref<HTMLElement | null>(null);
    const highlightedIndex = ref(0);
    const selectionPending = ref(false);
    const selectionFailed = ref(false);
    const itemRefs = ref<HTMLElement[]>([]);
    let scrollFrame: number | null = null;

    const visibleItems = computed(() =>
        sortPromptSnippets(props.data?.items ?? []).slice(0, PROMPT_SNIPPET_MAX_ITEMS)
    );
    const storageBlocked = computed(
        () => !canWritePromptSnippetStorage(props.data?.storageIssue ?? null)
    );
    const insertionModeLabel = computed(() =>
        props.data?.insertionMode === 'paste_and_send'
            ? t('settings.general.promptSnippets.pasteAndSend')
            : t('settings.general.promptSnippets.pasteOnly')
    );
    const storageMessage = computed(() => {
        return props.data?.storageIssue === 'unsupported_version'
            ? t('settings.general.promptSnippets.storageUnsupported')
            : t('settings.general.promptSnippets.storageReadOnly');
    });
    const storageNotice = computed(() => {
        if (props.data?.storageIssue === 'invalid_items') {
            return t('settings.general.promptSnippets.itemsInvalid');
        }
        if (props.data?.storageIssue === 'too_many_items') {
            return t('settings.general.promptSnippets.limitReached', {
                count: PROMPT_SNIPPET_MAX_ITEMS,
            });
        }
        return null;
    });

    function scheduleHighlightScroll() {
        void nextTick(() => {
            if (scrollFrame !== null) {
                cancelAnimationFrame(scrollFrame);
            }
            scrollFrame = requestAnimationFrame(() => {
                itemRefs.value[highlightedIndex.value]?.scrollIntoView({
                    block: 'nearest',
                    behavior: 'auto',
                });
                scrollFrame = null;
            });
        });
    }

    async function handleSelect(index: number) {
        if (selectionPending.value || storageBlocked.value) {
            return;
        }

        const item = visibleItems.value[index];
        if (!item || !props.onSelect) {
            return;
        }

        selectionPending.value = true;
        selectionFailed.value = false;
        try {
            await props.onSelect(item);
        } catch {
            selectionFailed.value = true;
        } finally {
            selectionPending.value = false;
        }
    }

    function handleKeyDown(event: KeyboardEvent) {
        if (matchShortcut(props.data?.toggleShortcut, event)) {
            event.preventDefault();
            emit('close');
            return;
        }

        if (event.key === 'Escape' || event.key === 'Esc') {
            event.preventDefault();
            emit('close');
            return;
        }

        if (storageBlocked.value || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }

        if (/^[1-9]$/.test(event.key)) {
            event.preventDefault();
            void handleSelect(Number(event.key) - 1);
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            highlightedIndex.value = Math.min(
                highlightedIndex.value + 1,
                Math.max(visibleItems.value.length - 1, 0)
            );
            scheduleHighlightScroll();
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
            scheduleHighlightScroll();
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            void handleSelect(highlightedIndex.value);
        }
    }

    function handleOverlayShown() {
        highlightedIndex.value = 0;
        rootRef.value?.focus({ preventScroll: true });
    }

    watch(
        () => visibleItems.value.length,
        (length) => {
            highlightedIndex.value = Math.min(highlightedIndex.value, Math.max(length - 1, 0));
            itemRefs.value.length = Math.min(itemRefs.value.length, length);
        }
    );

    onUnmounted(() => {
        if (scrollFrame !== null) {
            cancelAnimationFrame(scrollFrame);
            scrollFrame = null;
        }
    });

    defineExpose({
        handleOverlayShown,
        handleKeyDown,
    });
</script>
