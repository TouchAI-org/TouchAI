<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import ModelCapabilityTags from '@components/ModelCapabilityTags.vue';
    import ModelLogo from '@components/ModelLogo.vue';
    import SvgIcon from '@components/SvgIcon.vue';
    import { AppEvent, eventService } from '@services/EventService';
    import type { ModelDropdownData, ModelDropdownPopupItem } from '@services/PopupService';
    import { computed, nextTick, ref, watch } from 'vue';

    defineOptions({
        name: 'PopupModelDropdown',
    });

    interface Props {
        data: ModelDropdownData | null;
        isInPopup?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        isInPopup: false,
    });

    const emit = defineEmits<{
        close: [];
    }>();

    // 从 data 解构出需要的字段
    const activeModelId = computed(() => props.data?.activeModelId ?? '');
    const activeProviderId = computed(() => props.data?.activeProviderId ?? null);
    const selectedModelId = computed(() => props.data?.selectedModelId ?? '');
    const selectedProviderId = computed(() => props.data?.selectedProviderId ?? null);
    const searchQuery = computed(() => props.data?.searchQuery ?? '');

    const highlightedIndex = ref(0);
    const dropdownRef = ref<HTMLElement | null>(null);
    const itemRefs = ref<HTMLElement[]>([]);
    let scrollRafId: number | null = null;

    // 模型列表由主窗口生成并透传，popup 只负责展示和交互。
    const models = computed<ModelDropdownPopupItem[]>(() => props.data?.models ?? []);

    const emptyStateIcon = computed(() => {
        return searchQuery.value ? 'search' : 'database';
    });

    const emptyStateMessage = computed(() => {
        return searchQuery.value ? '没有找到匹配的模型' : '请先在设置中心配置模型';
    });

    // 根据搜索查询过滤模型
    const filteredModels = computed(() => {
        if (!searchQuery.value) return models.value;
        const query = searchQuery.value.toLowerCase().trim();
        if (!query) return models.value;

        const tokens = query.split(/\s+/).filter(Boolean);
        const scored = models.value
            .map((model) => {
                const fields = [
                    model.name.toLowerCase(),
                    model.modelId.toLowerCase(),
                    model.providerName.toLowerCase(),
                    `${model.providerName} ${model.modelId}`.toLowerCase(),
                ];

                let totalScore = 0;
                for (const token of tokens) {
                    let best = -1;
                    for (const field of fields) {
                        const score = scoreMatch(token, field);
                        if (score > best) best = score;
                    }
                    if (best < 0) {
                        return null;
                    }
                    totalScore += best;
                }

                return { model, score: totalScore };
            })
            .filter(Boolean) as Array<{ model: ModelDropdownPopupItem; score: number }>;

        return scored.sort((a, b) => b.score - a.score).map((item) => item.model);
    });

    function scoreMatch(token: string, text: string): number {
        if (!token) return -1;
        const index = text.indexOf(token);
        if (index !== -1) {
            return 200 - index;
        }
        if (isSubsequence(token, text)) {
            return 100;
        }
        return -1;
    }

    function isSubsequence(needle: string, haystack: string): boolean {
        let i = 0;
        for (const ch of haystack) {
            if (ch === needle[i]) {
                i += 1;
                if (i >= needle.length) return true;
            }
        }
        return false;
    }

    // 滚动到高亮的项（合并多次键盘滚动，避免延迟）
    const scrollToHighlighted = async () => {
        await nextTick();
        if (scrollRafId !== null) {
            cancelAnimationFrame(scrollRafId);
        }
        scrollRafId = requestAnimationFrame(() => {
            const highlightedElement = itemRefs.value[highlightedIndex.value];
            if (highlightedElement && dropdownRef.value) {
                highlightedElement.scrollIntoView({
                    block: 'nearest',
                    behavior: 'auto',
                });
            }
            scrollRafId = null;
        });
    };

    // 处理模型选择 - 自己 emit 到主窗口
    async function handleSelect(modelDbId: number) {
        await eventService.emit(AppEvent.POPUP_MODEL_SELECT, { modelDbId });
        emit('close');
    }

    // 键盘导航
    function handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            emit('close');
            return;
        }

        if (filteredModels.value.length === 0) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            highlightedIndex.value = Math.min(
                highlightedIndex.value + 1,
                filteredModels.value.length - 1
            );
            scrollToHighlighted();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
            scrollToHighlighted();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const model = filteredModels.value[highlightedIndex.value];
            if (model) handleSelect(model.id);
        }
    }

    // 重置高亮索引当搜索改变时
    watch(searchQuery, () => {
        highlightedIndex.value = 0;
    });

    // 重置高亮索引当 data 变化时（相当于打开）
    watch(
        () => props.data,
        (newVal) => {
            if (newVal) {
                highlightedIndex.value = 0;
            }
        }
    );

    // 只暴露键盘处理，模型下拉本身不需要在显示后额外接管焦点。
    defineExpose({
        handleKeyDown,
    });
</script>

<template>
    <div
        ref="dropdownRef"
        :class="[
            'custom-scrollbar-thin max-h-96 w-80 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg select-none',
            isInPopup ? '' : 'absolute top-full left-0 z-[9999] mt-2',
        ]"
    >
        <div
            v-for="(model, index) in filteredModels"
            :key="model.id + index"
            :ref="
                (el) => {
                    if (el) itemRefs[index] = el as HTMLElement;
                }
            "
            :class="[
                'flex cursor-pointer items-center gap-3 px-4 py-2',
                index === highlightedIndex ? 'bg-primary-50' : 'hover:bg-gray-50',
            ]"
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
                        class="flex-shrink-0 rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px] leading-none text-gray-600 shadow-sm"
                    >
                        当前
                    </span>
                    <span
                        v-if="
                            model.modelId === activeModelId && model.providerId === activeProviderId
                        "
                        class="rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px] leading-none text-gray-600 shadow-sm"
                    >
                        默认
                    </span>
                </div>
            </div>
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs font-medium">{{ model.name }}</span>
                    <span class="text-[11px] text-gray-500">{{ model.providerName }}</span>
                </div>
                <div class="mt-1">
                    <ModelCapabilityTags :model="model" size="sm" />
                </div>
            </div>
        </div>
        <div
            v-if="filteredModels.length === 0"
            class="flex min-h-[120px] flex-col items-center justify-center px-4"
        >
            <SvgIcon :name="emptyStateIcon" class="mb-3 h-12 w-12 text-gray-300" />
            <p class="text-center text-sm text-gray-400">
                {{ emptyStateMessage }}
            </p>
        </div>
    </div>
</template>
