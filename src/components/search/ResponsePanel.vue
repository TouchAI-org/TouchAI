<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div class="relative w-full">
        <div
            ref="responseContainer"
            tabindex="0"
            class="response-container custom-scrollbar bg-background-primary w-full overflow-y-auto px-10 py-5"
            :style="{ maxHeight: `${maxHeight}px` }"
            @scroll="handleScroll"
        >
            <div class="flex items-center justify-end gap-1">
                <button
                    class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    aria-label="Pin response panel"
                    @click.stop="togglePinned"
                >
                    <SvgIcon
                        name="pin"
                        class="h-4 w-4 transition-transform duration-200 ease-in-out"
                        :class="isPinned ? 'rotate-[-30deg]' : 'rotate-0'"
                    />
                </button>
                <button
                    class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    aria-label="Copy full markdown"
                    @click.stop="copyFullMarkdown"
                >
                    <SvgIcon name="copy" class="h-4 w-4" />
                </button>
            </div>

            <div v-if="reasoning || isThinking" class="reasoning-section mb-4 w-full">
                <button
                    class="flex w-full items-center gap-2 px-1 py-2 text-left text-sm font-normal text-gray-700 transition-colors hover:text-gray-900"
                    @click="toggleReasoning"
                >
                    <SvgIcon
                        name="chevron-right"
                        :class="
                            isReasoningExpanded
                                ? 'h-4 w-4 rotate-90 transition-transform'
                                : 'h-4 w-4 transition-transform'
                        "
                    />
                    <span v-if="isThinking">思考中</span>
                    <span v-else>已思考（用时 {{ reasoningDuration }} 秒）</span>
                    <span
                        v-if="isThinking"
                        class="ml-2 flex items-center gap-1 text-xs text-gray-500"
                    >
                        <div class="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-500"></div>
                    </span>
                </button>
                <div
                    v-show="isReasoningExpanded"
                    ref="reasoningContainer"
                    class="reasoning-content custom-scrollbar-thin mt-2 max-h-60 w-full overflow-y-auto border-l-1 border-gray-300 py-1 pr-2 pl-4 text-sm text-gray-500"
                    @scroll="handleReasoningScroll"
                >
                    <MarkdownContent :content="reasoning" variant="reasoning" />
                </div>
            </div>

            <MarkdownContent v-if="content" :content="content" />

            <div v-if="error" class="p-4 text-sm text-red-600">
                <span class="font-semibold">Error:</span>
                {{ error.message }}
            </div>
        </div>

        <div
            v-if="showScrollToBottom"
            class="pointer-events-none absolute right-0 bottom-0 left-0 flex h-20 items-end justify-center rounded-lg pb-4"
            style="
                background: linear-gradient(
                    to bottom,
                    transparent 0%,
                    rgba(255, 255, 255, 0.95) 100%
                );
            "
        >
            <button
                class="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-lg transition-all hover:bg-gray-50 hover:shadow-xl"
                @click="scrollToBottom"
            >
                <SvgIcon name="arrow-down" class="h-5 w-5 text-gray-600" />
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
    import MarkdownContent from '@components/common/MarkdownContent.vue';
    import SvgIcon from '@components/common/SvgIcon.vue';
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    interface Props {
        content: string;
        reasoning?: string; // 推理内容
        isLoading: boolean;
        error: Error | null;
        maxHeight?: number;
        isPinned?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        maxHeight: 600,
        reasoning: '',
        isPinned: false,
    });

    const emit = defineEmits<{
        heightChange: [height: number];
        pinChange: [isPinned: boolean];
    }>();

    const responseContainer = ref<HTMLElement | null>(null);
    const reasoningContainer = ref<HTMLElement | null>(null);
    const isPinned = computed(() => props.isPinned);
    const isReasoningExpanded = ref(true); // 默认展开
    const isThinking = computed(() => props.isLoading && props.reasoning && !props.content);
    const reasoningStartTime = ref<number | null>(null);
    const reasoningDuration = ref(0);
    const showScrollToBottom = ref(false);
    const isAutoScrollEnabled = ref(true);
    const isReasoningAutoScrollEnabled = ref(true);
    let resizeObserver: ResizeObserver | null = null;

    // 暴露 focus 方法
    function focus() {
        responseContainer.value?.focus();
    }

    defineExpose({
        focus,
    });

    function togglePinned() {
        emit('pinChange', !props.isPinned);
    }

    async function copyFullMarkdown() {
        if (!props.content) return;
        try {
            await navigator.clipboard.writeText(props.content);
        } catch (error) {
            console.error('[ResponsePanel] Failed to copy markdown:', error);
        }
    }

    // 切换 reasoning 展开/收缩
    function toggleReasoning() {
        isReasoningExpanded.value = !isReasoningExpanded.value;
    }

    // 检查是否滚动到底部
    function isScrolledToBottom(container: HTMLElement | null): boolean {
        if (!container) return true;
        const { scrollTop, scrollHeight, clientHeight } = container;
        // 允许 5px 的误差
        return scrollHeight - scrollTop - clientHeight < 5;
    }

    // 检查内容是否超出容器（是否有滚动条）
    function hasScrollbar(): boolean {
        if (!responseContainer.value) return false;
        const { scrollHeight, clientHeight } = responseContainer.value;
        return scrollHeight > clientHeight;
    }

    // 处理主容器滚动事件
    function handleScroll() {
        if (!responseContainer.value) return;

        const atBottom = isScrolledToBottom(responseContainer.value);

        // 如果用户滚动到底部，恢复自动滚动并隐藏按钮
        if (atBottom) {
            isAutoScrollEnabled.value = true;
            showScrollToBottom.value = false;
        } else {
            // 如果用户向上滚动且内容超出容器，禁用自动滚动并显示按钮
            if (hasScrollbar()) {
                isAutoScrollEnabled.value = false;
                showScrollToBottom.value = true;
            }
        }
    }

    // 滚动到底部
    function scrollToBottom() {
        if (!responseContainer.value) return;
        responseContainer.value.scrollTop = responseContainer.value.scrollHeight;
        isAutoScrollEnabled.value = true;
        showScrollToBottom.value = false;
    }

    // 处理 reasoning 容器滚动事件
    function handleReasoningScroll() {
        if (!reasoningContainer.value) return;

        const atBottom = isScrolledToBottom(reasoningContainer.value);

        // 如果用户滚动到底部，恢复自动滚动
        if (atBottom) {
            isReasoningAutoScrollEnabled.value = true;
        } else {
            // 如果用户向上滚动，禁用自动滚动
            isReasoningAutoScrollEnabled.value = false;
        }
    }

    // 监听 reasoning 开始和结束，计算用时
    watch(
        () => props.reasoning,
        (newReasoning) => {
            if (newReasoning && !reasoningStartTime.value) {
                // reasoning 开始
                reasoningStartTime.value = Date.now();
            }
        }
    );

    // 当 content 开始出现时，自动收缩 reasoning 并计算用时
    watch(
        () => props.content,
        (newContent, oldContent) => {
            // 内容被清空时（新请求开始前），重置自动滚动状态和计时器
            if (!newContent && oldContent) {
                isAutoScrollEnabled.value = true;
                isReasoningAutoScrollEnabled.value = true;
                showScrollToBottom.value = false;
                // 重置 reasoning 计时器
                reasoningStartTime.value = null;
                reasoningDuration.value = 0;
            }

            // 新请求开始时（从无内容到有内容），确保自动滚动已启用
            if (newContent && !oldContent) {
                isAutoScrollEnabled.value = true;
                showScrollToBottom.value = false;

                if (props.reasoning) {
                    // content 开始出现，reasoning 完成
                    if (reasoningStartTime.value) {
                        const duration = (Date.now() - reasoningStartTime.value) / 1000;
                        reasoningDuration.value = Math.round(duration * 10) / 10; // 保留1位小数
                    }
                    isReasoningExpanded.value = false;
                }
            }
        }
    );

    // 自动滚动主容器到底部（仅在启用自动滚动时）
    watch(
        () => props.content,
        async () => {
            if (!isAutoScrollEnabled.value) return;

            await nextTick();
            if (responseContainer.value) {
                responseContainer.value.scrollTop = responseContainer.value.scrollHeight;
            }
        }
    );

    // 自动滚动 reasoning 容器到底部（仅在启用自动滚动时）
    watch(
        () => props.reasoning,
        async () => {
            if (!isReasoningAutoScrollEnabled.value || !isReasoningExpanded.value) return;

            await nextTick();
            if (reasoningContainer.value) {
                reasoningContainer.value.scrollTop = reasoningContainer.value.scrollHeight;
            }
        }
    );

    // 使用 ResizeObserver 实时监听容器高度变化
    onMounted(() => {
        if (responseContainer.value) {
            resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    // 使用 borderBoxSize 获取更精确的尺寸
                    const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.clientHeight;
                    emit('heightChange', height);
                }
            });

            resizeObserver.observe(responseContainer.value);

            // 初始触发一次高度变化事件
            nextTick(() => {
                if (responseContainer.value) {
                    emit('heightChange', responseContainer.value.offsetHeight);
                }
            });
        }
    });

    // 清理 ResizeObserver
    onBeforeUnmount(() => {
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
    });
</script>

<style scoped>
    /* 移除焦点时的默认边框 */
    .response-container:focus {
        outline: none;
    }

    /* Reasoning 内容样式 */
    .reasoning-content {
        font-family:
            'Source Han Sans CN',
            'Noto Sans SC',
            -apple-system,
            BlinkMacSystemFont,
            'Segoe UI',
            sans-serif;
        line-height: 1.8;
    }

    .reasoning-content :deep(p) {
        margin-bottom: 0.75em;
        color: #6b7280; /* gray-500 */
    }

    .reasoning-content :deep(ul),
    .reasoning-content :deep(ol) {
        padding-left: 1.25em;
        margin-bottom: 0.75em;
    }

    .reasoning-content :deep(li) {
        margin-bottom: 0.5em;
        color: #6b7280; /* gray-500 */
    }

    .reasoning-content :deep(strong) {
        font-weight: 600;
        color: #6b7280; /* gray-500 */
    }

    .reasoning-content :deep(code) {
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 0.9em;
        background-color: #f3f4f6; /* gray-100 */
        padding: 0.15em 0.35em;
        border-radius: 3px;
        color: #6b7280; /* gray-500 */
    }

    .reasoning-content :deep(h1),
    .reasoning-content :deep(h2),
    .reasoning-content :deep(h3),
    .reasoning-content :deep(h4),
    .reasoning-content :deep(h5),
    .reasoning-content :deep(h6) {
        color: #6b7280; /* gray-500 */
        font-weight: 600;
    }
</style>
