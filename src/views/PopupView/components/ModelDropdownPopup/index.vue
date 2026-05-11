<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<template>
    <div
        data-model-dropdown-popover="true"
        :class="[
            'model-dropdown-popover max-h-96 overflow-hidden rounded-lg border border-stone-200/90 bg-white shadow-lg backdrop-blur',
            isInPopup ? 'w-full' : 'absolute top-full left-0 z-[9999] mt-2 w-80',
        ]"
    >
        <div class="border-b border-stone-200/80 px-3 py-2.5">
            <label
                class="history-search-field focus-within:border-primary-300 flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 transition-colors focus-within:bg-white"
            >
                <AppIcon name="search" class="h-3.5 w-3.5 text-stone-400" />
                <input
                    ref="searchInputRef"
                    :value="localSearchQuery"
                    type="text"
                    autofocus
                    placeholder="搜索模型名称、ID 或供应商"
                    class="w-full border-0 bg-transparent text-xs text-stone-700 outline-none placeholder:text-stone-400"
                    @input="handleSearchInput"
                />
            </label>
        </div>

        <div
            ref="dropdownListRef"
            class="custom-scrollbar-thin max-h-[20rem] overflow-y-auto px-2 py-2"
        >
            <div
                v-for="(model, index) in models"
                :key="model.id"
                :ref="
                    (el) => {
                        if (el) itemRefs[index] = el as HTMLElement;
                    }
                "
                class="model-dropdown-row flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors"
                :class="{
                    'model-dropdown-row--highlighted': index === highlightedIndex,
                }"
                @mouseenter="highlightedIndex = index"
                @click="handleSelect(model.id)"
            >
                <div class="relative">
                    <ModelLogo :model-id="model.modelId" :name="model.name" size="sm" />
                    <div
                        class="absolute top-full left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap"
                    >
                        <span
                            v-if="
                                model.modelId === selectedModelId &&
                                model.providerId === selectedProviderId
                            "
                            class="rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px] leading-none text-gray-600 shadow-sm"
                        >
                            当前
                        </span>
                        <span
                            v-if="
                                model.modelId === activeModelId &&
                                model.providerId === activeProviderId
                            "
                            class="rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px] leading-none text-gray-600 shadow-sm"
                        >
                            默认
                        </span>
                    </div>
                </div>
                <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="text-xs font-medium text-stone-900">{{ model.name }}</span>
                        <span class="text-[11px] text-stone-500">{{ model.providerName }}</span>
                    </div>
                    <div class="mt-1">
                        <ModelCapabilityTags :model="model" size="sm" />
                    </div>
                </div>
            </div>

            <div
                v-if="models.length === 0"
                class="flex min-h-24 flex-col items-center justify-center gap-2 px-6 text-center"
            >
                <AppIcon :name="emptyStateIcon" class="h-7 w-7 text-stone-300" />
                <p class="font-serif text-xs text-stone-700">
                    {{ emptyStateMessage }}
                </p>
                <p class="text-[11px] leading-4 text-stone-500">
                    {{
                        effectiveSearchQuery
                            ? '可以尝试更短的关键词重新搜索'
                            : '请先在设置中心配置模型'
                    }}
                </p>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { AppIconName } from '@components/appIconMap';
    import ModelCapabilityTags from '@components/ModelCapabilityTags.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import { AppEvent, eventService } from '@services/EventService';
    import type {
        ModelDropdownData,
        ModelDropdownPopupItem,
        PopupSessionIdentity,
    } from '@services/PopupService';
    import { computed, nextTick, ref, watch } from 'vue';

    defineOptions({
        name: 'PopupModelDropdown',
    });

    interface Props {
        data: ModelDropdownData | null;
        isInPopup?: boolean;
        popupIdentity?: PopupSessionIdentity | null;
    }

    const props = withDefaults(defineProps<Props>(), {
        isInPopup: false,
        popupIdentity: null,
    });

    const emit = defineEmits<{
        close: [];
    }>();

    const activeModelId = computed(() => props.data?.activeModelId ?? '');
    const activeProviderId = computed(() => props.data?.activeProviderId ?? null);
    const selectedModelId = computed(() => props.data?.selectedModelId ?? '');
    const selectedProviderId = computed(() => props.data?.selectedProviderId ?? null);
    const searchQuery = computed(() => props.data?.searchQuery ?? '');
    const models = computed<ModelDropdownPopupItem[]>(() => props.data?.models ?? []);
    const effectiveSearchQuery = computed(() => {
        return localSearchQuery.value.trim() || searchQuery.value.trim();
    });

    const searchInputRef = ref<HTMLInputElement | null>(null);
    const highlightedIndex = ref(0);
    const itemRefs = ref<HTMLElement[]>([]);
    const localSearchQuery = ref(props.data?.searchQuery ?? '');
    let scrollRafId: number | null = null;

    const emptyStateIcon = computed<AppIconName>(() => {
        return effectiveSearchQuery.value ? 'search' : 'database';
    });

    const emptyStateMessage = computed(() => {
        return effectiveSearchQuery.value ? '没有找到匹配的模型' : '还没有可用模型';
    });

    async function handleSelect(modelDbId: number) {
        if (!props.popupIdentity) {
            return;
        }

        await eventService.emit(AppEvent.POPUP_MODEL_SELECT, {
            ...props.popupIdentity,
            modelDbId,
        });
        emit('close');
    }

    function handleSearchInput(event: Event) {
        const target = event.target as HTMLInputElement;
        localSearchQuery.value = target.value;
        if (!props.popupIdentity) {
            return;
        }

        void eventService.emit(AppEvent.POPUP_MODEL_SEARCH_QUERY_CHANGE, {
            ...props.popupIdentity,
            query: target.value,
        });
    }

    const scrollToHighlighted = async () => {
        await nextTick();
        if (scrollRafId !== null) {
            cancelAnimationFrame(scrollRafId);
        }

        scrollRafId = requestAnimationFrame(() => {
            const highlightedElement = itemRefs.value[highlightedIndex.value];
            if (highlightedElement) {
                highlightedElement.scrollIntoView({
                    block: 'nearest',
                    behavior: 'auto',
                });
            }
            scrollRafId = null;
        });
    };

    function handleKeyDown(event: KeyboardEvent) {
        if (event.ctrlKey && event.key.toLowerCase() === 'm') {
            event.preventDefault();
            emit('close');
            return;
        }

        if (models.value.length === 0) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            highlightedIndex.value = Math.min(highlightedIndex.value + 1, models.value.length - 1);
            void scrollToHighlighted();
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
            void scrollToHighlighted();
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            const model = models.value[highlightedIndex.value];
            if (model) {
                void handleSelect(model.id);
            }
        }
    }

    function handlePopupShown() {
        searchInputRef.value?.focus({ preventScroll: true });
        if (!localSearchQuery.value) {
            searchInputRef.value?.select();
        }
        highlightedIndex.value = 0;
    }

    watch(
        () => searchQuery.value,
        (value) => {
            if (value === localSearchQuery.value) {
                return;
            }

            localSearchQuery.value = value;
        }
    );

    watch(searchQuery, () => {
        highlightedIndex.value = 0;
    });

    watch(
        () => props.data,
        (value) => {
            if (value) {
                highlightedIndex.value = 0;
            }
        }
    );

    defineExpose({
        handlePopupShown,
        handleKeyDown,
    });
</script>

<style scoped>
    .history-search-field {
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
    }

    .model-dropdown-row:hover,
    .model-dropdown-row--highlighted {
        background: color-mix(in srgb, var(--color-primary-50) 92%, white);
    }
</style>
