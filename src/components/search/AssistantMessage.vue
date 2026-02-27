<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="message-bubble justify-start">
        <div class="message-content w-full">
            <div class="ai-message">
                <!-- 取消消息特殊样式 -->
                <div v-if="message.isCancelled" class="cancelled-message text-gray-500 italic">
                    {{ message.content }}
                </div>

                <!-- 正常 AI 消息 -->
                <template v-else>
                    <!-- 推理过程显示（如果存在）-->
                    <div v-if="message.reasoning" class="reasoning-section mb-4 w-full">
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
                            <span v-if="message.isStreaming && !message.content">思考中</span>
                            <span v-else>推理过程</span>
                            <span
                                v-if="message.isStreaming && !message.content"
                                class="ml-2 flex items-center gap-1 text-xs text-gray-500"
                            >
                                <div
                                    class="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-500"
                                ></div>
                            </span>
                        </button>
                        <div
                            v-show="isReasoningExpanded"
                            class="reasoning-content custom-scrollbar-thin mt-2 max-h-60 w-full overflow-y-auto border-l-1 border-gray-300 py-1 pr-2 pl-4 text-sm text-gray-500"
                        >
                            <MarkdownContent
                                :content="message.reasoning"
                                :final="!message.isStreaming"
                                variant="reasoning"
                            />
                        </div>
                    </div>

                    <!-- 工具调用显示（如果存在）-->
                    <ToolCallSection
                        :tool-calls="message.toolCalls"
                        :message-content="message.content"
                    />

                    <!-- 主要内容 -->
                    <MarkdownContent :content="message.content" :final="!message.isStreaming" />

                    <!-- 流式响应加载指示器 -->
                    <div
                        v-if="message.isStreaming"
                        class="streaming-indicator mt-2 flex items-center gap-2"
                    >
                        <div class="loading-dots flex gap-1">
                            <span class="dot"></span>
                            <span class="dot"></span>
                            <span class="dot"></span>
                        </div>
                    </div>

                    <!-- AI 消息底部操作按钮 -->
                    <div v-if="!message.isStreaming" class="mt-3 flex items-center gap-1">
                        <button
                            class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                            aria-label="Copy message"
                            @click.stop="handleCopy"
                        >
                            <SvgIcon name="copy" class="h-4 w-4" />
                        </button>
                        <button
                            class="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                            aria-label="Regenerate response"
                            @click.stop="handleRegenerate"
                        >
                            <SvgIcon name="refresh" class="h-4 w-4" />
                        </button>
                    </div>
                </template>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import MarkdownContent from '@components/common/MarkdownContent.vue';
    import SvgIcon from '@components/common/SvgIcon.vue';
    import ToolCallSection from '@components/search/ToolCallSection.vue';
    import type { ConversationMessage } from '@composables/useAgent.ts';
    import { sendNotification } from '@tauri-apps/plugin-notification';
    import { ref, watch } from 'vue';

    interface Props {
        message: ConversationMessage;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        regenerate: [messageId: string];
    }>();

    const isReasoningExpanded = ref(true); // 默认展开

    // 切换 reasoning 展开/收缩
    function toggleReasoning() {
        isReasoningExpanded.value = !isReasoningExpanded.value;
    }

    // 当 content 开始出现时，自动收缩 reasoning
    watch(
        () => props.message.content,
        (newContent, oldContent) => {
            if (newContent && !oldContent && props.message.reasoning) {
                isReasoningExpanded.value = false;
            }
        }
    );

    // 复制消息内容
    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(props.message.content);
            // 显示复制成功提示
            sendNotification({
                title: 'TouchAI',
                body: '已复制到剪贴板',
            });
        } catch (error) {
            console.error('[AssistantMessage] Failed to copy message:', error);
            // 显示复制失败提示
            sendNotification({
                title: 'TouchAI',
                body: '复制失败',
            });
        }
    }

    // 重新生成响应
    function handleRegenerate() {
        emit('regenerate', props.message.id);
    }
</script>

<style scoped>
    .message-bubble {
        display: flex;
        margin-bottom: 1rem;
    }

    .message-content {
        word-wrap: break-word;
        overflow-wrap: break-word;
    }

    .ai-message {
        font-size: 15px;
        line-height: 1.8;
    }

    /* 取消消息样式 */
    .cancelled-message {
        font-size: 14px;
        line-height: 1.6;
        color: var(--color-gray-400);
    }

    /* reasoning 样式 */
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
        color: var(--color-gray-500);
    }

    .reasoning-content :deep(ul),
    .reasoning-content :deep(ol) {
        padding-left: 1.25em;
        margin-bottom: 0.75em;
    }

    .reasoning-content :deep(li) {
        margin-bottom: 0.5em;
        color: var(--color-gray-500);
    }

    .reasoning-content :deep(strong) {
        font-weight: 600;
        color: var(--color-gray-500);
    }

    .reasoning-content :deep(code) {
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 0.9em;
        background-color: var(--color-gray-100);
        padding: 0.15em 0.35em;
        border-radius: 3px;
        color: var(--color-gray-500);
    }

    .reasoning-content :deep(h1),
    .reasoning-content :deep(h2),
    .reasoning-content :deep(h3),
    .reasoning-content :deep(h4),
    .reasoning-content :deep(h5),
    .reasoning-content :deep(h6) {
        color: var(--color-gray-500);
        font-weight: 600;
    }

    /* 加载点动画 */
    .loading-dots {
        display: flex;
        align-items: center;
    }

    .dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background-color: var(--color-gray-500);
        animation: pulse 1.4s infinite ease-in-out;
    }

    .dot:nth-child(1) {
        animation-delay: -0.32s;
    }

    .dot:nth-child(2) {
        animation-delay: -0.16s;
    }

    @keyframes pulse {
        0%,
        80%,
        100% {
            opacity: 0.3;
            transform: scale(0.8);
        }
        40% {
            opacity: 1;
            transform: scale(1);
        }
    }
</style>
