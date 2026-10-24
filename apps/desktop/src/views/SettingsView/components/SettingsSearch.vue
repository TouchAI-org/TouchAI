<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Input } from '@components/ui/input';
    import { computed, nextTick, ref, useId, watch } from 'vue';

    import { t } from '@/i18n';

    import { searchSettings, type SettingsSearchResult } from '../settingsSearch';

    const props = defineProps<{ collapsed: boolean }>();
    const emit = defineEmits<{
        select: [result: SettingsSearchResult];
        expand: [];
    }>();

    const query = defineModel<string>({ default: '' });
    const activeIndex = ref(0);
    // ui/Input 通过 defineExpose 暴露 focus()，不是原生 HTMLInputElement
    const inputRef = ref<{ focus: () => void } | null>(null);
    const resultsRef = ref<HTMLElement | null>(null);
    const results = computed(() => searchSettings(query.value));
    const searching = computed(() => query.value.trim().length > 0);
    const listId = useId();

    function focusInput() {
        emit('expand');
        void nextTick(() => inputRef.value?.focus());
    }

    function clearSearch() {
        query.value = '';
        inputRef.value?.focus();
    }

    function selectResult(result: SettingsSearchResult) {
        emit('select', result);
        query.value = '';
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            clearSearch();
        } else if (event.key === 'Enter' && results.value[activeIndex.value]) {
            event.preventDefault();
            selectResult(results.value[activeIndex.value]!);
        } else if (results.value.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            activeIndex.value =
                (activeIndex.value + direction + results.value.length) % results.value.length;
            void nextTick(() => {
                resultsRef.value
                    ?.querySelectorAll('[role="option"]')
                    [activeIndex.value]?.scrollIntoView({ block: 'nearest' });
            });
        }
    }

    watch(results, () => {
        activeIndex.value = 0;
    });
    watch(
        () => props.collapsed,
        (collapsed) => {
            if (collapsed) query.value = '';
        }
    );
</script>

<template>
    <button
        v-if="collapsed"
        type="button"
        class="mx-auto mb-4 flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-neutral-600 hover:bg-surface-hover-soft"
        :title="t('settings.sidebar.searchPlaceholder')"
        :aria-label="t('settings.sidebar.searchPlaceholder')"
        @click="focusInput"
    >
        <AppIcon name="search" class="h-[17px] w-[17px]" />
    </button>

    <div
        v-else
        :class="['mb-4 flex min-h-0 flex-col', searching ? 'flex-1' : 'shrink-0']"
        data-testid="settings-search"
    >
        <div class="relative mx-1 shrink-0">
            <AppIcon
                name="search"
                class="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400"
            />
            <Input
                ref="inputRef"
                v-model="query"
                variant="filled"
                type="search"
                role="combobox"
                autocomplete="off"
                spellcheck="false"
                :placeholder="t('settings.sidebar.searchPlaceholder')"
                :aria-label="t('settings.sidebar.searchPlaceholder')"
                :aria-expanded="searching"
                :aria-controls="searching ? listId : undefined"
                :aria-activedescendant="
                    searching && results.length ? `${listId}-${activeIndex}` : undefined
                "
                aria-autocomplete="list"
                class="h-9 w-full pr-8 pl-8 text-[12px] [&::-webkit-search-cancel-button]:appearance-none"
                data-testid="settings-search-input"
                @keydown="handleKeydown"
            />
            <button
                v-if="query"
                type="button"
                class="absolute top-1/2 right-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700"
                :aria-label="t('common.clear')"
                @click="clearSearch"
            >
                <AppIcon name="x" class="h-3.5 w-3.5" />
            </button>
        </div>

        <div
            v-if="searching"
            :id="listId"
            ref="resultsRef"
            role="listbox"
            :aria-label="t('settings.sidebar.searchResults')"
            class="settings-scrollbar mt-2 min-h-0 space-y-1 overflow-y-auto pr-1"
            data-testid="settings-search-results"
        >
            <button
                v-for="(result, index) in results"
                :id="`${listId}-${index}`"
                :key="result.id"
                type="button"
                role="option"
                :aria-selected="activeIndex === index"
                :class="[
                    'flex w-full items-start gap-2.5 rounded-control px-3 py-2.5 text-left transition-colors',
                    activeIndex === index
                        ? 'bg-surface-selected text-neutral-950'
                        : 'text-neutral-700 hover:bg-surface-hover-soft',
                ]"
                @click="selectResult(result)"
            >
                <AppIcon :name="result.icon" class="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" />
                <span class="min-w-0">
                    <span class="block text-compact leading-5 break-words">{{ result.label }}</span>
                    <span class="mt-0.5 block text-caption leading-4 text-neutral-500">
                        {{ result.sectionLabel }}
                    </span>
                </span>
            </button>
            <p v-if="!results.length" role="status" class="px-3 py-5 text-xs text-neutral-500">
                {{ t('settings.sidebar.noSearchResults') }}
            </p>
        </div>
    </div>
</template>
