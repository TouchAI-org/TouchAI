<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="mb-4 flex justify-start">
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
                    <!-- 推理过程显示（如果存在）-->
                    <div v-if="message.reasoning" class="reasoning-section mb-4 w-full">
                        <button
                            class="flex w-full items-center gap-2 px-1 py-2 text-left text-sm font-normal text-gray-700 transition-colors hover:text-gray-900"
                            @click="toggleReasoning"
                        >
                            <AppIcon
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

                    <div v-if="renderedParts.length > 0" class="assistant-message-parts">
                        <div
                            v-for="part in renderedParts"
                            :key="part.id"
                            class="assistant-message-part"
                        >
                            <MarkdownContent
                                v-if="part.type === 'text'"
                                :content="part.content"
                                :final="!message.isStreaming"
                            />
                            <ToolCallItem
                                v-else-if="part.type === 'tool_call'"
                                :tool-call="part.toolCall"
                            />
                            <WidgetFrame v-else-if="part.type === 'widget'" :widget="part.widget" />
                            <ToolApprovalCard
                                v-else-if="part.type === 'approval'"
                                :approval="part.approval"
                                :attention-token="
                                    part.approval.status === 'pending' ? approvalAttentionToken : 0
                                "
                                @approve="handleApprove"
                                @reject="handleReject"
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
                    <div v-if="message.isStreaming" :class="streamingIndicatorClass">
                        <div class="flex items-center gap-1">
                            <span class="dot"></span>
                            <span class="dot"></span>
                            <span class="dot"></span>
                        </div>
                        <span class="loading-tip">{{ currentTip }}</span>
                    </div>
                </template>

                <div v-if="showMessageActions" class="mt-3 flex items-center gap-1">
                    <ActionButton icon="copy" :handler="handleCopy" aria-label="Copy message" />
                    <ActionButton
                        icon="refresh"
                        :handler="handleRegenerate"
                        aria-label="Regenerate response"
                    />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import ActionButton from '@components/ActionButton.vue';
    import AppIcon from '@components/AppIcon.vue';
    import MarkdownContent from '@components/MarkdownContent.vue';
    import { computed, onUnmounted, ref, watch } from 'vue';
    import { notify } from '@services/NotificationService';

    import { SHOW_WIDGET_TOOL_NAME } from '@/services/BuiltInToolService/tools/widgetTool';
    import { clipboardService } from '@/services/ClipboardService';
    import { useSettingsStore } from '@/stores/settings';
    import type {
        SessionMessage,
        ToolApprovalInfo,
        ToolCallInfo,
        WidgetInfo,
    } from '@/types/session';

    import ToolApprovalCard from './ToolApprovalCard.vue';
    import ToolCallItem from './ToolCallItem.vue';
    import WidgetFrame from './WidgetFrame.vue';

    interface Props {
        message: SessionMessage;
        approvalAttentionToken?: number;
    }

    const props = withDefaults(defineProps<Props>(), {
        approvalAttentionToken: 0,
    });

    const emit = defineEmits<{
        regenerate: [messageId: string];
        approveToolApproval: [callId: string];
        rejectToolApproval: [callId: string];
    }>();

    type RenderedPart =
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

    // ── 加载提示轮播（#136：加载指示器旁显示上下文提示）──────────────────

    const settingsStore = useSettingsStore();

    // 快捷键提示动态读取用户设置中的实际快捷键
    const shortcutTip = computed(() => `按 ${settingsStore.globalShortcut} 快速呼出/隐藏 TouchAI`);

    // TODO: 后续改为数据驱动 — 提示列表应从配置文件/远程源获取，支持动态扩展和本地化
    const BASE_TIPS = [
        '按 Ctrl+Enter 发送消息',
        '支持拖拽图片到输入框直接发送',
        '在输入框输入 @ 可快速切换模型',
        '点击历史按钮可查看和切换会话',
        '按 Ctrl+K 打开快速搜索面板',
        '右键消息可复制或重新生成回复',
        '在设置中可自定义全局快捷键和主题',
        '按 Esc 可逐步清除输入内容',
        '长消息支持 Markdown 渲染和代码高亮',
        '工具调用结果会内联展示在对话中',
    ];

    const allTips = computed(() => [shortcutTip.value, ...BASE_TIPS]);

    // UI 层记忆：跨流式会话保持轮播进度，确保提示均等曝光
    let lastTipIndex = 0;

    const currentTipIndex = ref(0);
    const currentTip = computed(() => allTips.value[currentTipIndex.value]);

    let tipTimer: ReturnType<typeof setInterval> | null = null;

    function startTipRotation() {
        const len = allTips.value.length;
        if (len <= 1) return;
        currentTipIndex.value = lastTipIndex % len;
        tipTimer = setInterval(() => {
            currentTipIndex.value = (currentTipIndex.value + 1) % len;
        }, 5000);
    }

    function stopTipRotation() {
        if (tipTimer !== null) {
            clearInterval(tipTimer);
            tipTimer = null;
        }
        lastTipIndex = currentTipIndex.value;
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

    const isReasoningExpanded = ref(true); // 默认展开
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
        const lastPart = renderedParts.value[renderedParts.value.length - 1];
        const marginTop =
            lastPart?.type === 'tool_call' || lastPart?.type === 'approval' ? 'mt-4' : 'mt-2';

        return ['streaming-indicator', 'flex', 'items-center', 'gap-2', marginTop];
    });
    const showMessageActions = computed(() => {
        return !props.message.isStreaming && !isRequestStateMessage.value;
    });

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

    async function handleCopy() {
        try {
            await clipboardService.writeText(props.message.content);
            notify({ title: 'TouchAI', body: '已复制到剪贴板' });
        } catch (error) {
            console.error('[AssistantMessage] Failed to copy:', error);
            notify({ title: 'TouchAI', body: '复制失败' });
        }
    }

    function handleRegenerate() {
        emit('regenerate', props.message.id);
    }

    function handleApprove(callId: string) {
        emit('approveToolApproval', callId);
    }

    function handleReject(callId: string) {
        emit('rejectToolApproval', callId);
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

    .loading-tip {
        font-size: 12px;
        color: var(--color-gray-400);
        margin-left: 8px;
        white-space: nowrap;
        opacity: 0.6;
        transition: opacity 0.4s ease;
    }
</style>
