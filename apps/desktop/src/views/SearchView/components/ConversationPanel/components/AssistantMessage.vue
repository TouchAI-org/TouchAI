<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="flex justify-start" :class="message.isStreaming ? 'mb-0' : 'mb-4'">
        <div class="w-full break-words">
            <div class="text-[15px] leading-[1.8]">
                <!-- 请求状态消息 -->
                <div
                    v-if="isRequestStateMessage"
                    class="font-serif text-[13px] leading-[1.6] text-gray-500"
                >
                    {{ message.content }}
                </div>

                <!-- 正常 AI 消息 -->
                <template v-else>
                    <div v-if="renderedParts.length > 0" class="assistant-message-parts">
                        <div
                            v-for="part in renderedParts"
                            :key="part.id"
                            class="assistant-message-part"
                        >
                            <ReasoningBlock
                                v-if="part.type === 'reasoning'"
                                :content="part.content"
                                :is-streaming="part.isStreaming"
                                :started-at="part.startedAt"
                                :ended-at="part.endedAt"
                            />
                            <MarkdownContent
                                v-else-if="part.type === 'text'"
                                :content="part.content"
                                :final="!message.isStreaming"
                            />
                            <ToolCallItem
                                v-else-if="part.type === 'tool_call'"
                                :tool-call="part.toolCall"
                            />
                            <WidgetFrame v-else-if="part.type === 'widget'" :widget="part.widget" />
                            <ToolApprovalHistoryCard
                                v-else-if="part.type === 'approval'"
                                :approval="part.approval"
                            />
                        </div>
                    </div>

                    <div
                        v-if="message.statusText"
                        class="mt-3 font-serif text-sm leading-[1.6] text-gray-500"
                    >
                        {{ message.statusText }}
                    </div>

                    <!-- 流式响应加载指示器 -->
                    <div
                        v-if="message.isStreaming && !askUserStore.current"
                        :class="streamingIndicatorClass"
                    >
                        <div class="flex items-center gap-1">
                            <span class="dot"></span>
                            <span class="dot"></span>
                            <span class="dot"></span>
                        </div>
                        <Transition name="tip-fade" mode="out-in">
                            <span v-if="tipVisible" :key="currentTipIndex" class="loading-tip">
                                {{ currentTip }}
                            </span>
                        </Transition>
                    </div>
                </template>

                <div v-if="showMessageActions" class="mt-3 flex items-center gap-1">
                    <ActionButton
                        icon="copy"
                        :handler="handleCopy"
                        :aria-label="t('assistant.action.copyMessage')"
                    />
                    <ActionButton
                        icon="refresh"
                        :handler="handleRegenerate"
                        :aria-label="t('assistant.action.regenerateResponse')"
                    />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import ActionButton from '@components/ActionButton.vue';
    import MarkdownContent from '@components/MarkdownContent.vue';
    import { notify } from '@services/NotificationService';
    import { computed, onUnmounted, ref, watch } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import { SHOW_WIDGET_TOOL_NAME } from '@/services/BuiltInToolService/tools/widgetTool';
    import { clipboardService } from '@/services/ClipboardService';
    import { useAskUserStore } from '@/stores/askUser';
    import type {
        SessionMessage,
        ToolApprovalInfo,
        ToolCallInfo,
        WidgetInfo,
    } from '@/types/session';

    import ReasoningBlock from './ReasoningBlock.vue';
    import ToolApprovalHistoryCard from './ToolApprovalHistoryCard.vue';
    import ToolCallItem from './ToolCallItem.vue';
    import WidgetFrame from './WidgetFrame.vue';

    interface Props {
        message: SessionMessage;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        regenerate: [messageId: string];
    }>();

    type RenderedPart =
        | {
              id: string;
              type: 'reasoning';
              content: string;
              isStreaming: boolean;
              startedAt?: number;
              endedAt?: number;
          }
        | {
              id: string;
              type: 'text';
              content: string;
          }
        | {
              id: string;
              type: 'tool_call';
              toolCall: ToolCallInfo;
          }
        | {
              id: string;
              type: 'widget';
              widget: WidgetInfo;
          }
        | {
              id: string;
              type: 'approval';
              approval: ToolApprovalInfo;
          };

    type LoadingTipKey = Extract<MessageKey, `assistant.loadingTip.${string}`>;

    const TIPS: LoadingTipKey[] = [
        'assistant.loadingTip.newLine',
        'assistant.loadingTip.switchModel',
        'assistant.loadingTip.history',
        'assistant.loadingTip.alwaysOnTop',
        'assistant.loadingTip.newSession',
        'assistant.loadingTip.historyButton',
        'assistant.loadingTip.copy',
        'assistant.loadingTip.regenerate',
    ];
    const DEFAULT_LOADING_TIP_KEY = 'assistant.loadingTip.newLine' satisfies LoadingTipKey;

    // UI 层记忆：跨流式会话保持轮播进度，确保提示均等曝光
    const lastTipIndex = ref(0);

    const currentTipIndex = ref(0);
    const tipVisible = ref(false);
    const currentTip = computed(() => t(TIPS[currentTipIndex.value] ?? DEFAULT_LOADING_TIP_KEY));

    const askUserStore = useAskUserStore();

    let tipTimer: ReturnType<typeof setInterval> | null = null;
    let tipDelayTimer: ReturnType<typeof setTimeout> | null = null;

    function startTipRotation() {
        const len = TIPS.length;
        if (len <= 1) return;
        // 20 秒延迟后才显示 tip
        tipDelayTimer = setTimeout(() => {
            tipVisible.value = true;
            currentTipIndex.value = lastTipIndex.value % len;
            tipTimer = setInterval(() => {
                currentTipIndex.value = (currentTipIndex.value + 1) % len;
            }, 5000);
        }, 20000);
    }

    function stopTipRotation() {
        if (tipDelayTimer !== null) {
            clearTimeout(tipDelayTimer);
            tipDelayTimer = null;
        }
        if (tipTimer !== null) {
            clearInterval(tipTimer);
            tipTimer = null;
        }
        tipVisible.value = false;
        lastTipIndex.value = currentTipIndex.value;
    }

    // 跟随 streaming 状态启停轮播（组件生命周期可能跨多次请求）
    watch(
        () => props.message.isStreaming,
        (streaming) => {
            if (streaming) {
                startTipRotation();
            } else {
                stopTipRotation();
            }
        },
        { immediate: true }
    );

    onUnmounted(() => {
        stopTipRotation();
    });

    const isRequestStateMessage = computed(() => {
        return !!(props.message.isCancelled || props.message.isRetrying || props.message.isError);
    });
    const renderedParts = computed<RenderedPart[]>(() => {
        const toolCallMap = new Map(
            (props.message.toolCalls ?? []).map((toolCall) => [toolCall.id, toolCall])
        );
        const approvalMap = new Map(
            (props.message.approvals ?? []).map((approval) => [approval.callId, approval])
        );
        const widgetMap = new Map(
            (props.message.widgets ?? []).map((widget) => [widget.widgetId, widget])
        );
        const parts: RenderedPart[] = [];
        const widgetBackedToolCallIds = new Set(
            (props.message.widgets ?? []).map((widget) => widget.callId)
        );

        for (const part of props.message.parts) {
            if (part.type === 'reasoning') {
                parts.push({
                    ...part,
                    isStreaming: !!props.message.isStreaming && part.isStreaming,
                });
                continue;
            }
            if (part.type === 'text') {
                if (part.content) {
                    parts.push({
                        id: part.id,
                        type: 'text',
                        content: part.content,
                    });
                }
                continue;
            }

            if (part.type === 'tool_call') {
                const toolCall = toolCallMap.get(part.callId);
                const shouldHideToolCall =
                    toolCall?.namespacedName === SHOW_WIDGET_TOOL_NAME ||
                    widgetBackedToolCallIds.has(part.callId);
                if (toolCall && !shouldHideToolCall) {
                    parts.push({
                        id: part.id,
                        type: 'tool_call',
                        toolCall,
                    });
                }
                continue;
            }

            if (part.type === 'widget') {
                const widget = widgetMap.get(part.widgetId);
                if (widget) {
                    parts.push({
                        id: part.id,
                        type: 'widget',
                        widget,
                    });
                }
                continue;
            }

            const approval = approvalMap.get(part.callId);
            if (approval) {
                parts.push({
                    id: part.id,
                    type: 'approval',
                    approval,
                });
            }
        }

        return parts;
    });
    const streamingIndicatorClass = computed(() => {
        const marginTop = 'mt-5';

        return ['streaming-indicator', 'flex', 'items-center', 'gap-2', marginTop, 'mb-2'];
    });
    const showMessageActions = computed(() => {
        return !props.message.isStreaming && !isRequestStateMessage.value;
    });

    async function handleCopy() {
        try {
            await clipboardService.writeText(props.message.content);
            notify({ title: 'TouchAI', body: t('notification.copy.copiedToClipboard') });
        } catch (error) {
            console.error('[AssistantMessage] Failed to copy:', error);
            notify({ title: 'TouchAI', body: t('common.copyFailed') });
        }
    }

    function handleRegenerate() {
        emit('regenerate', props.message.id);
    }
</script>

<style scoped>
    .assistant-message-parts {
        display: grid;
        gap: 0.72rem;
    }

    .assistant-message-part {
        min-width: 0;
    }

    .streaming-indicator {
        min-height: 1.2em;
        min-width: 0;
    }

    .dot {
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background-color: var(--color-gray-500);
        animation: pulse var(--motion-status-cycle) infinite var(--ease-in-out);
    }

    .dot:nth-child(1) {
        animation-delay: var(--motion-status-delay-1);
    }

    .dot:nth-child(2) {
        animation-delay: var(--motion-status-delay-2);
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

    .loading-tip {
        font-size: 12px;
        font-weight: 600;
        font-family: var(--font-serif);
        color: var(--color-gray-500);
        min-width: 0;
        max-width: 100%;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.45;
        opacity: 0.7;
        transition: opacity var(--duration-fast) var(--ease-smooth-out);
    }

    .tip-fade-enter-active {
        transition: opacity var(--duration-fast) var(--ease-smooth-out);
    }
    .tip-fade-leave-active {
        transition: opacity var(--duration-fast) var(--ease-smooth-out);
    }
    .tip-fade-enter-from,
    .tip-fade-leave-to {
        opacity: 0;
    }
    .tip-fade-enter-to,
    .tip-fade-leave-from {
        opacity: 0.6;
    }
</style>
