<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script
    setup
    lang="ts"
    generic="
        T extends {
            value: string | number;
            label: string;
            description?: string;
            searchText?: string;
        }
    "
>
    import SvgIcon from '@components/SvgIcon.vue';
    import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

    interface Props {
        modelValue: T['value'] | null;
        options: T[];
        placeholder?: string;
        searchPlaceholder?: string;
        emptyText?: string;
        disabled?: boolean;
    }

    interface Emits {
        (e: 'update:modelValue', value: T['value']): void;
    }

    defineSlots<{
        selected?(props: { option: T | null }): unknown;
        option?(props: { option: T; highlighted: boolean; selected: boolean }): unknown;
    }>();

    const props = withDefaults(defineProps<Props>(), {
        placeholder: '请选择',
        searchPlaceholder: '搜索',
        emptyText: '暂无可选项',
        disabled: false,
    });

    const emit = defineEmits<Emits>();

    const isOpen = ref(false);
    const searchQuery = ref('');
    const highlightedIndex = ref(0);
    const rootRef = ref<HTMLElement | null>(null);
    const searchInputRef = ref<HTMLInputElement | null>(null);
    const itemRefs = ref<HTMLElement[]>([]);

    const selectedOption = computed(() => {
        return props.options.find((option) => option.value === props.modelValue) ?? null;
    });

    /**
     * 过滤逻辑采用“包含优先 + 子序列兜底”，
     * 同时支持完整词，以及服务商名、模型名等关键片段搜索。
     */
    const filteredOptions = computed(() => {
        const query = searchQuery.value.trim().toLowerCase();
        if (!query) {
            return props.options;
        }

        const tokens = query.split(/\s+/).filter(Boolean);
        const scoredOptions = props.options
            .map((option) => {
                const searchableText = `${option.label} ${option.description ?? ''} ${
                    option.searchText ?? ''
                }`.toLowerCase();

                let totalScore = 0;
                for (const token of tokens) {
                    const score = scoreMatch(token, searchableText);
                    if (score < 0) {
                        return null;
                    }
                    totalScore += score;
                }

                return {
                    option,
                    score: totalScore,
                };
            })
            .filter(Boolean) as Array<{ option: T; score: number }>;

        return scoredOptions
            .sort((left, right) => right.score - left.score)
            .map((item) => item.option);
    });

    function scoreMatch(token: string, text: string): number {
        if (!token) {
            return -1;
        }

        const directMatchIndex = text.indexOf(token);
        if (directMatchIndex !== -1) {
            return 200 - directMatchIndex;
        }

        if (isSubsequence(token, text)) {
            return 100;
        }

        return -1;
    }

    function isSubsequence(needle: string, haystack: string): boolean {
        let needleIndex = 0;

        for (const character of haystack) {
            if (character === needle[needleIndex]) {
                needleIndex += 1;
                if (needleIndex >= needle.length) {
                    return true;
                }
            }
        }

        return false;
    }

    function focusSearchInput() {
        void nextTick(() => {
            searchInputRef.value?.focus();
            searchInputRef.value?.select();
        });
    }

    function openDropdown() {
        if (props.disabled || isOpen.value) {
            return;
        }

        isOpen.value = true;
        focusSearchInput();
    }

    function closeDropdown() {
        if (!isOpen.value) {
            return;
        }

        isOpen.value = false;
        searchQuery.value = '';
        itemRefs.value = [];
    }

    function toggleDropdown() {
        if (isOpen.value) {
            closeDropdown();
            return;
        }

        openDropdown();
    }

    function selectOption(option: T) {
        emit('update:modelValue', option.value);
        closeDropdown();
    }

    function moveHighlight(direction: -1 | 1) {
        if (filteredOptions.value.length === 0) {
            return;
        }

        highlightedIndex.value = Math.max(
            0,
            Math.min(filteredOptions.value.length - 1, highlightedIndex.value + direction)
        );

        void nextTick(() => {
            itemRefs.value[highlightedIndex.value]?.scrollIntoView({
                block: 'nearest',
                behavior: 'auto',
            });
        });
    }

    function handleTriggerKeydown(event: KeyboardEvent) {
        if (props.disabled) {
            return;
        }

        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openDropdown();
        }
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeDropdown();
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveHighlight(1);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveHighlight(-1);
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            const option = filteredOptions.value[highlightedIndex.value];
            if (option) {
                selectOption(option);
            }
        }
    }

    function handlePointerDownOutside(event: PointerEvent) {
        const target = event.target as Node | null;
        if (!target || rootRef.value?.contains(target)) {
            return;
        }

        closeDropdown();
    }

    watch(filteredOptions, (options) => {
        if (options.length === 0) {
            highlightedIndex.value = 0;
            return;
        }

        if (highlightedIndex.value >= options.length) {
            highlightedIndex.value = options.length - 1;
        }
    });

    watch(
        () => props.modelValue,
        () => {
            if (isOpen.value) {
                return;
            }

            searchQuery.value = '';
        }
    );

    watch(isOpen, (open) => {
        if (open) {
            highlightedIndex.value = Math.max(
                0,
                filteredOptions.value.findIndex((option) => option.value === props.modelValue)
            );
            document.addEventListener('pointerdown', handlePointerDownOutside);
            return;
        }

        document.removeEventListener('pointerdown', handlePointerDownOutside);
    });

    onUnmounted(() => {
        document.removeEventListener('pointerdown', handlePointerDownOutside);
    });
</script>

<template>
    <div ref="rootRef" class="relative">
        <button
            type="button"
            :disabled="disabled"
            class="flex h-10 w-full items-center justify-between rounded-lg border px-3 py-2 text-left font-serif text-sm transition-colors"
            :class="{
                'border-primary-400 bg-white text-gray-900': isOpen && !disabled,
                'border-gray-200 bg-white text-gray-900 hover:border-gray-300':
                    !isOpen && !disabled,
                'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-400': disabled,
            }"
            @click="toggleDropdown"
            @keydown="handleTriggerKeydown"
        >
            <div class="min-w-0 flex-1">
                <slot name="selected" :option="selectedOption">
                    <span class="block truncate">
                        {{ selectedOption?.label || placeholder }}
                    </span>
                </slot>
            </div>
            <SvgIcon
                name="chevron-down"
                :class="`ml-3 h-4 w-4 flex-shrink-0 text-gray-400 transition-transform ${
                    isOpen ? 'rotate-180' : ''
                }`"
            />
        </button>

        <div
            v-if="isOpen"
            class="absolute top-full left-0 z-30 mt-2 w-full rounded-xl border border-gray-200 bg-white shadow-lg"
        >
            <div class="border-b border-gray-100 p-2">
                <div class="relative">
                    <SvgIcon
                        name="search"
                        class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400"
                    />
                    <input
                        ref="searchInputRef"
                        v-model="searchQuery"
                        type="text"
                        class="focus:border-primary-400 h-9 w-full rounded-lg border border-gray-200 bg-white pr-3 pl-9 font-serif text-sm text-gray-900 transition-colors focus:outline-none"
                        :placeholder="searchPlaceholder"
                        @keydown="handleSearchKeydown"
                    />
                </div>
            </div>

            <div class="custom-scrollbar-thin max-h-64 overflow-y-auto p-1">
                <button
                    v-for="(option, index) in filteredOptions"
                    :key="`${option.value}:${index}`"
                    :ref="
                        (element) => {
                            if (element) {
                                itemRefs[index] = element as HTMLElement;
                            }
                        }
                    "
                    type="button"
                    class="flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors"
                    :aria-selected="option.value === modelValue"
                    :class="[
                        index === highlightedIndex
                            ? 'bg-primary-50 text-primary-700'
                            : option.value === modelValue
                              ? 'bg-primary-50/80 text-primary-700 ring-primary-100 ring-1'
                              : 'text-gray-900 hover:bg-gray-50',
                    ]"
                    @mouseenter="highlightedIndex = index"
                    @mousedown.prevent="selectOption(option)"
                >
                    <slot
                        name="option"
                        :option="option"
                        :highlighted="index === highlightedIndex"
                        :selected="option.value === modelValue"
                    >
                        <span class="truncate font-serif text-sm font-medium">
                            {{ option.label }}
                        </span>
                        <span
                            v-if="option.description"
                            class="mt-0.5 truncate text-xs text-gray-500"
                        >
                            {{ option.description }}
                        </span>
                    </slot>
                </button>

                <div
                    v-if="filteredOptions.length === 0"
                    class="px-3 py-6 text-center font-serif text-sm text-gray-500"
                >
                    {{ emptyText }}
                </div>
            </div>
        </div>
    </div>
</template>
