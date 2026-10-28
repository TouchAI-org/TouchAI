<!-- Copyright (c) 2026. 鍗冭瘹. Licensed under GPL v3 -->

<template>
    <div class="flex justify-start" :class="message.isStreaming ? 'mb-0' : 'mb-4'">
        <div class="w-full break-words">
            <div class="text-reading leading-[1.8]">
                <!-- 璇锋眰鐘舵€佹秷鎭?-->
                <div
                    v-if="isRequestStateMessage"
                    class="font-serif text-compact leading-[1.6] text-gray-500"
                >
                    {{ message.content }}
                </div>

                <!-- 姝ｅ父 AI 娑堟伅 -->
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

                    <!-- 娴佸紡鍝嶅簲鍔犺浇鎸囩ず鍣?-->
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
import { log } from '@services/ObservabilityService';
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';
    import { SHOW_WIDGET_TOOL_NAME } from '@/services/BuiltInToolService/tools/widgetTool';
    import { clipboardService } from '@/services/ClipboardService';
    import { useAskUserStore } from '@/stores/askUser';
    import type {
        SessionMessage,
        ToolApprovalInfo,
        ToolCallInfo,
        WidgetInfo,
    } from '@/types/session';
    import {
        normalizeCitationUrl,
        normalizeWrappedCitations,
        WEB_SEARCH_CITATIONS_KEY,
        type WebSearchCitationRegistry,
    } from '@/views/SearchView/components/WebSearch/citations';

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

    // UI 灞傝蹇嗭細璺ㄦ祦寮忎細璇濅繚鎸佽疆鎾繘搴︼紝纭繚鎻愮ず鍧囩瓑鏇濆厜
    const lastTipIndex = ref(0);

    const currentTipIndex = ref(0);
    const tipVisible = ref(false);
    const currentTip = computed(() => t(TIPS[currentTipIndex.value] ?? DEFAULT_LOADING_TIP_KEY));

    const askUserStore = useAskUserStore();

    let tipTimer: ReturnType<typeof setInterval> | null = null;
    let tipDelayTimer: ReturnType<typeof setTimeout> | null = null;

    function isDocumentHidden(): boolean {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    function startTipRotation() {
        const len = TIPS.length;
        if (len <= 1) return;
        // 绐楀彛闅愯棌鏃朵笉杞挱锛氱敤鎴风湅涓嶅埌 tip锛屽畾鏃跺櫒鍙細鐧藉崰涓荤嚎绋嬨€?        if (isDocumentHidden()) return;
        // 20 绉掑欢杩熷悗鎵嶆樉绀?tip
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
        if (!props.message.isStreaming) {
            return;
        }

        if (isDocumentHidden()) {
            stopTipRotation();
            return;
        }

        startTipRotation();
    }

    // 璺熼殢 streaming 鐘舵€佸惎鍋滆疆鎾紙缁勪欢鐢熷懡鍛ㄦ湡鍙兘璺ㄥ娆¤姹傦級
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
     * 鎶婃湰娑堟伅閲屾墍鏈?WebSearch 鏉ユ簮鎸?URL 姹囨€绘垚涓€寮犳煡鎵捐〃銆?     *
     * 涓€鏉?assistant 娑堟伅鍙兘鍖呭惈澶氳疆鎼滅储锛屾寜 URL 鍘婚噸鍚庝緵琛屽唴寮曠敤鍙嶆煡銆?     * 杩欓噷涓嶅垎閰嶅簭鍙凤細chip 鏈韩涓嶆樉绀烘暟瀛楋紙鏉ユ簮鍗＄墖鐨勫簭鍙锋槸鍗曟鎼滅储鍐呯殑锛夛紝
     * 涓ゅ搴忓彿瀹规槗瀵逛笉涓娿€?     */
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

    // provide 瑕佸湪 setup 鏈熼棿璋冪敤锛屼絾鏌ユ壘蹇呴』瀹炴椂璇?computed锛?    // 鍚﹀垯娴佸紡鏂板鐨勬悳绱㈢粨鏋滀細琚攣姝诲湪鍒濆蹇収閲屻€?    provide<WebSearchCitationRegistry>(WEB_SEARCH_CITATIONS_KEY, {
        findByUrl: (url) => citationIndex.value.get(normalizeCitationUrl(url)),
    });

    /**
     * 妯″瀷甯稿父鎶婃潵婧愬啓鎴愩€岋紙[鏍囬](url)锛夈€傘€嶆垨銆屻€?[鏍囬](url))銆嶃€?     * 鍙敼鍛戒腑鏈鎼滅储鏉ユ簮鐨勯摼鎺ワ紝涓嶇鏅€氭嫭鍙峰紩鐢ㄣ€?     */
    function normalizeContent(content: string): string {
        const index = citationIndex.value;
        return normalizeWrappedCitations(content, (url) => index.has(url));
    }
    const renderedParts = computed<RenderedPart[]>(() => {
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
                        content: normalizeContent(part.content),
                    });
                }
                continue;
            }

            if (part.type === 'tool_call') {
                const toolCall = part.toolCall;
                const shouldHideToolCall =
                    toolCall.namespacedName === SHOW_WIDGET_TOOL_NAME ||
                    widgetBackedToolCallIds.has(toolCall.id);
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
                // 流式草稿阶段 widgetId 可能还停在 callId 上；用 callId 回退，
                // 避免 id 切换瞬间把部件过滤掉造成整块闪现。
                // 回退只在候选确实有内容时成立：用空 html 的候选去渲染会把已画好的部件清空。
                const widget =
                    widgetMap.get(part.widgetId) ??
                    (props.message.widgets ?? []).find(
                        (candidate) =>
                            candidate.callId === part.widgetId &&
                            typeof candidate.html === 'string' &&
                            candidate.html.length > 0
                    );
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
