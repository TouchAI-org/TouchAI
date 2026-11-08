<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div
        class="flex justify-start"
        :class="message.isStreaming || isRequestStateMessage ? 'mb-0' : 'mb-4'"
    >
        <div class="w-full break-words">
            <div class="text-reading leading-[1.8]">
                <!-- 正常 AI 消息 -->
                <template v-if="!isRequestStateMessage">
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
                                v-else-if="part.type === 'text' && part.visualType === 'markdown'"
                                :content="part.content"
                                :final="!message.isStreaming"
                            />
                            <OpenUIReply
                                v-else-if="part.type === 'text' && part.visualType === 'openui'"
                                :response="part.content"
                                :is-streaming="!!message.isStreaming"
                            />
                            <VisualArtifactFrame
                                v-else-if="
                                    part.type === 'text' &&
                                    part.visualType === 'artifact' &&
                                    !message.isStreaming
                                "
                                :html="part.content"
                            />
                            <VisualArtifactFrame
                                v-else-if="part.type === 'widget' && !message.isStreaming"
                                :html="part.html"
                                :title="part.title"
                            />
                            <ToolCallItem
                                v-else-if="part.type === 'tool_call'"
                                :tool-call="part.toolCall"
                            />
                            <ToolApprovalHistoryCard
                                v-else-if="part.type === 'approval'"
                                :approval="part.approval"
                            />
                            <StatusDivider
                                v-else-if="part.type === 'context_compaction'"
                                icon="compress"
                                :loading="part.state === 'compacting'"
                                :label="
                                    tt(
                                        part.state === 'compacting'
                                            ? '正在压缩上下文'
                                            : '上下文已压缩'
                                    )
                                "
                            />
                        </div>
                    </div>

                    <div
                        v-if="message.statusText"
                        class="mt-3 font-serif text-sm leading-[1.6] text-muted-foreground"
                    >
                        {{ message.statusText }}
                    </div>
                </template>

                <div
                    v-if="isRequestStateMessage || (message.isStreaming && !askUserStore.current)"
                    class="mt-5 mb-2 flex min-h-6 items-center gap-2 font-serif text-compact leading-6 text-text-tertiary"
                    :class="{ invisible: isCompacting && !isRequestStateMessage }"
                    :aria-hidden="(isCompacting && !isRequestStateMessage) || undefined"
                    data-request-status
                >
                    <span v-if="isRequestStateMessage">{{ message.content }}</span>
                    <template v-else>
                        <div class="flex shrink-0 items-center gap-1">
                            <span class="dot"></span>
                            <span class="dot"></span>
                            <span class="dot"></span>
                        </div>
                        <Transition name="tip-fade" mode="out-in">
                            <span v-if="tipVisible" :key="currentTipIndex" class="loading-tip">
                                {{ currentTip }}
                            </span>
                        </Transition>
                    </template>
                </div>

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
    import StatusDivider from '@components/ui/status-divider/StatusDivider.vue';
    import { useMotion } from '@composables/useMotion';
    import { notify } from '@services/NotificationService';
    import { log } from '@services/ObservabilityService';
    import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';

    import { type MessageKey, t, tt } from '@/i18n';
    import { runResultAction } from '@/services/AnalyticsService/productInteractions';
    import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';
    import { clipboardService } from '@/services/ClipboardService';
    import {
        LEGACY_SHOW_WIDGET_TOOL_NAME,
        parseVisualReplySegments,
    } from '@/services/VisualReplyService/protocol';
    import { useAskUserStore } from '@/stores/askUser';
    import type {
        ContextCompactionMessagePart,
        SessionMessage,
        ToolApprovalInfo,
        ToolCallInfo,
    } from '@/types/session';
    import {
        normalizeCitationUrl,
        normalizeWrappedCitations,
        WEB_SEARCH_CITATIONS_KEY,
        type WebSearchCitationRegistry,
    } from '@/views/SearchView/components/WebSearch/citations';

    import OpenUIReply from './OpenUIReply.vue';
    import ReasoningBlock from './ReasoningBlock.vue';
    import ToolApprovalHistoryCard from './ToolApprovalHistoryCard.vue';
    import ToolCallItem from './ToolCallItem.vue';
    import VisualArtifactFrame from './VisualArtifactFrame.vue';

    interface Props {
        message: SessionMessage;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        regenerate: [messageId: string];
    }>();

    type RenderedPart =
        | ContextCompactionMessagePart
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
              visualType: 'markdown' | 'openui' | 'artifact';
          }
        | {
              id: string;
              type: 'tool_call';
              toolCall: ToolCallInfo;
          }
        | {
              id: string;
              type: 'approval';
              approval: ToolApprovalInfo;
          }
        | {
              id: string;
              type: 'widget';
              html: string;
              title: string;
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
    const isCompacting = computed(() =>
        props.message.parts.some(
            (part) => part.type === 'context_compaction' && part.state === 'compacting'
        )
    );
    const { windowVisible } = useMotion();

    let tipTimer: ReturnType<typeof setInterval> | null = null;
    let tipDelayTimer: ReturnType<typeof setTimeout> | null = null;

    function isDocumentHidden(): boolean {
        return !windowVisible.value || document.visibilityState === 'hidden';
    }

    function startTipRotation() {
        stopTipRotation();
        const len = TIPS.length;
        if (len <= 1) return;
        // 窗口隐藏时不轮播：用户看不到 tip，定时器只会白占主线程。
        if (isDocumentHidden()) return;
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

    function handleVisibilityChange() {
        if (!props.message.isStreaming || isCompacting.value) {
            return;
        }

        if (isDocumentHidden()) {
            stopTipRotation();
            return;
        }

        startTipRotation();
    }

    watch(windowVisible, handleVisibilityChange);

    // 跟随 streaming 状态启停轮播（组件生命周期可能跨多次请求）
    watch(
        () => props.message.isStreaming && !isCompacting.value,
        (streaming) => {
            if (streaming) {
                startTipRotation();
            } else {
                stopTipRotation();
            }
        },
        { immediate: true }
    );

    onMounted(() => {
        document.addEventListener('visibilitychange', handleVisibilityChange);
    });

    onUnmounted(() => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        stopTipRotation();
    });

    const isRequestStateMessage = computed(() => {
        return !!(props.message.isCancelled || props.message.isRetrying || props.message.isError);
    });

    /**
     * 把本消息里所有 WebSearch 来源按 URL 汇总成一张查找表。
     *
     * 一条 assistant 消息可能包含多轮搜索，按 URL 去重后供行内引用反查。
     * 这里不分配序号：chip 本身不显示数字（来源卡片的序号是单次搜索内的），
     * 两套序号容易对不上。
     */
    const citationIndex = computed(() => {
        const byUrl = new Map<string, WebSearchSource>();

        for (const part of props.message.parts) {
            if (part.type !== 'tool_call') continue;
            const payload = part.toolCall.structuredPayload;
            if (!payload || payload.kind !== 'web_search_sources') continue;

            for (const source of payload.sources) {
                const key = normalizeCitationUrl(source.url);
                if (!key || byUrl.has(key)) continue;
                byUrl.set(key, source);
            }
        }

        return byUrl;
    });

    // provide 要在 setup 期间调用，但查找必须实时读 computed，
    // 否则流式新增的搜索结果会被锁死在初始快照里。
    provide<WebSearchCitationRegistry>(WEB_SEARCH_CITATIONS_KEY, {
        findByUrl: (url) => citationIndex.value.get(normalizeCitationUrl(url)),
    });

    /**
     * 模型常常把来源写成「（[标题](url)）。」或「。([标题](url))」。
     * 只改命中本次搜索来源的链接，不碰普通括号引用。
     */
    function normalizeContent(content: string): string {
        const index = citationIndex.value;
        return normalizeWrappedCitations(content, (url) => index.has(url));
    }
    const renderedParts = computed<RenderedPart[]>(() => {
        const approvalMap = new Map(
            (props.message.approvals ?? []).map((approval) => [approval.callId, approval])
        );
        const legacyWidgetMap = new Map(
            (props.message.legacyArtifacts ?? []).map((widget) => [widget.widgetId, widget])
        );
        const parts: RenderedPart[] = [];

        for (const part of props.message.parts) {
            if (part.type === 'context_compaction') {
                parts.push(part);
                continue;
            }
            if (part.type === 'reasoning') {
                parts.push({
                    ...part,
                    isStreaming: !!props.message.isStreaming && part.isStreaming,
                });
                continue;
            }
            if (part.type === 'text') {
                if (part.content) {
                    for (const segment of parseVisualReplySegments(part.content)) {
                        parts.push({
                            id: `${part.id}-${segment.id}`,
                            type: 'text',
                            visualType: segment.type,
                            content:
                                segment.type === 'markdown'
                                    ? normalizeContent(segment.content)
                                    : segment.content,
                        });
                    }
                }
                continue;
            }

            if (part.type === 'tool_call') {
                const toolCall = part.toolCall;
                const shouldHideToolCall = toolCall.namespacedName === LEGACY_SHOW_WIDGET_TOOL_NAME;
                if (!shouldHideToolCall) {
                    parts.push({
                        id: part.id,
                        type: 'tool_call',
                        toolCall,
                    });
                }
                continue;
            }

            if (part.type === 'widget') {
                const widget = legacyWidgetMap.get(part.widgetId);
                if (widget) {
                    parts.push({
                        id: part.id,
                        type: 'widget',
                        html: widget.html,
                        title: widget.title,
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
    const showMessageActions = computed(() => {
        return !props.message.isStreaming && !isRequestStateMessage.value;
    });

    async function handleCopy() {
        try {
            await runResultAction('copy_answer', () =>
                clipboardService.writeText(props.message.content)
            );
            notify({ title: 'TouchAI', body: t('notification.copy.copiedToClipboard') });
        } catch (error) {
            log.error('[AssistantMessage] Failed to copy:', error);
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

    .dot {
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background-color: var(--color-muted-foreground);
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
        color: var(--color-muted-foreground);
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
