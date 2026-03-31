// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { SessionTurn } from '@database/schema';
import { aiService } from '@services/AiService';
import { type Index } from '@services/AiService/attachments';
import { AiError, AiErrorCode } from '@services/AiService/errors';
import { buildConversationHistory } from '@services/AiService/history';
import { getRetryStatusMessage } from '@services/AiService/retry';
import {
    createSession,
    getSessionConversation,
    type SessionConversationData,
} from '@services/AiService/session';
import type { ToolEvent } from '@services/AiService/types';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { computed, ref } from 'vue';

import { useToolApproval } from '@/composables/useToolApproval';
import { useWidgetManager } from '@/composables/useWidgetManager';
import {
    buildBuiltInToolConversationPresentation,
    resolveBuiltInToolConversationSemantic,
} from '@/services/BuiltInToolService/presentation';
import { useMcpStore } from '@/stores/mcp';
import type {
    ConversationMessage,
    LoadedConversationSession,
    ToolApprovalInfo,
    ToolCallInfo,
} from '@/types/conversation';
import { createTextPart } from '@/utils/conversation';
import { collapseWhitespace, truncateText } from '@/utils/text';

export interface UseAiRequestOptions {
    sessionId?: number;
    onChunk?: (content: string) => void;
    onComplete?: (response: string) => void;
    onError?: (error: Error) => void;
    onModelSelected?: (target: { modelId: string; providerId: number }) => void;
}

function createDerivedStatusMessage(
    content: string,
    flags: Pick<ConversationMessage, 'isCancelled' | 'isError' | 'isRetrying'> = {}
): ConversationMessage {
    return {
        id: crypto.randomUUID(),
        role: 'assistant',
        content,
        parts: [createTextPart(content)],
        timestamp: Date.now(),
        ...flags,
    };
}

type ExtendedToolEvent = ToolEvent;

/**
 * 负责 AI 请求前端交互和状态管理：
 * - 控制加载态、错误态、响应内容
 * - 发起业务请求到 AiService
 * - 转发 UI 层回调
 * - 管理会话历史和历史会话恢复
 *
 * @param options UI 层回调和初始会话配置。
 * @returns AI 请求状态与会话操作方法。
 */
export function useAgent(options: UseAiRequestOptions = {}) {
    const isLoading = ref(false);
    const error = ref<Error | null>(null);
    const response = ref('');
    const reasoning = ref('');
    const currentTurn = ref<SessionTurn | null>(null);
    const abortController = ref<AbortController | null>(null);
    let requestId = 0;
    const mcpStore = useMcpStore();

    // 会话数据
    const currentSessionId = ref<number | null>(options.sessionId ?? null);
    const conversationHistory = ref<ConversationMessage[]>([]);

    const hasError = computed(() => error.value !== null);
    const hasResponse = computed(() => response.value.length > 0);

    const getAssistantMessageById = (messageId: string): ConversationMessage | undefined => {
        return conversationHistory.value.find(
            (message) => message.id === messageId && message.role === 'assistant'
        );
    };

    const removeConversationMessageById = (messageId: string): void => {
        conversationHistory.value = conversationHistory.value.filter(
            (message) => message.id !== messageId
        );
    };

    const createStreamingAssistantMessage = (): ConversationMessage => {
        conversationHistory.value.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            parts: [],
            timestamp: Date.now(),
            isStreaming: true,
        });

        return conversationHistory.value[conversationHistory.value.length - 1]!;
    };

    const {
        isHiddenBuiltinToolCall,
        upsertWidget,
        removeWidgetByWidgetId,
        handleToolCallDelta,
        upsertShowWidgetDraftFromFinalToolCall,
        finalizeToolCall,
        resetWidgetRuntime,
    } = useWidgetManager({
        conversationHistory,
        getAssistantMessageById,
    });

    const hasVisibleAssistantContent = (message: ConversationMessage): boolean => {
        if (message.content.trim() || message.reasoning?.trim()) {
            return true;
        }

        const toolCallMap = new Map(
            (message.toolCalls ?? []).map((toolCall) => [toolCall.id, toolCall])
        );
        const approvalCallIds = new Set(
            (message.approvals ?? []).map((approval) => approval.callId)
        );
        const widgetIds = new Set((message.widgets ?? []).map((widget) => widget.widgetId));
        const widgetBackedToolCallIds = new Set(
            (message.widgets ?? []).map((widget) => widget.callId)
        );

        return message.parts.some((part) => {
            if (part.type === 'text') {
                return !!part.content.trim();
            }

            if (part.type === 'tool_call') {
                const toolCall = toolCallMap.get(part.callId);
                return (
                    !!toolCall &&
                    !isHiddenBuiltinToolCall(toolCall.namespacedName) &&
                    !widgetBackedToolCallIds.has(part.callId)
                );
            }

            if (part.type === 'approval') {
                return approvalCallIds.has(part.callId);
            }

            return widgetIds.has(part.widgetId);
        });
    };

    const ensureAssistantToolCalls = (message: ConversationMessage): ToolCallInfo[] => {
        if (!message.toolCalls) {
            message.toolCalls = [];
        }

        return message.toolCalls;
    };

    const ensureAssistantApprovals = (message: ConversationMessage): ToolApprovalInfo[] => {
        if (!message.approvals) {
            message.approvals = [];
        }

        return message.approvals;
    };

    const ensureToolCallPart = (message: ConversationMessage, callId: string): void => {
        const hasPart = message.parts.some(
            (part) => part.type === 'tool_call' && part.callId === callId
        );

        if (!hasPart) {
            message.parts.push({
                id: crypto.randomUUID(),
                type: 'tool_call',
                callId,
            });
        }
    };

    const ensureApprovalPart = (message: ConversationMessage, callId: string): void => {
        const hasPart = message.parts.some(
            (part) => part.type === 'approval' && part.callId === callId
        );

        if (!hasPart) {
            message.parts.push({
                id: crypto.randomUUID(),
                type: 'approval',
                callId,
            });
        }
    };

    /**
     * 工具来源会决定 UI 上的附属 badge 文案。
     * 这里收口展示名规则，避免 MCP 和内置工具分散在多个组件中各自猜测。
     */
    const resolveToolDisplayInfo = (toolEvent: ExtendedToolEvent & { type: 'call_start' }) => {
        const source = toolEvent.source ?? (toolEvent.serverId ? 'mcp' : 'builtin');
        const namespacedName = toolEvent.namespacedName;
        const match = namespacedName.match(/^mcp__\d+__(.+)$/);
        const serverName =
            source === 'mcp' && toolEvent.serverId
                ? mcpStore.serverNameById(toolEvent.serverId)
                : undefined;

        return {
            source,
            sourceLabel:
                toolEvent.sourceLabel ??
                (source === 'builtin' ? '内置工具' : serverName || 'MCP 工具'),
            displayName: match?.[1] ?? toolEvent.toolName ?? namespacedName,
            serverName,
            serverId: toolEvent.serverId ?? null,
        };
    };

    const syncBuiltInToolCallPresentation = (toolCall: ToolCallInfo): void => {
        if (toolCall.source !== 'builtin') {
            delete toolCall.builtinConversationSemantic;
            delete toolCall.builtinPresentation;
            return;
        }

        if (!toolCall.builtinConversationSemantic && toolCall.result) {
            toolCall.builtinConversationSemantic =
                resolveBuiltInToolConversationSemantic(
                    toolCall.namespacedName || toolCall.name,
                    toolCall.arguments ?? {},
                    {
                        result: toolCall.result,
                    }
                ) ?? undefined;
        }
        toolCall.builtinPresentation =
            buildBuiltInToolConversationPresentation(
                toolCall.namespacedName || toolCall.name,
                toolCall.arguments ?? {},
                toolCall.status,
                {
                    semantic: toolCall.builtinConversationSemantic,
                    result: toolCall.result,
                }
            ) ?? undefined;
    };

    const upsertToolCall = (
        message: ConversationMessage,
        toolEvent: ExtendedToolEvent & { type: 'call_start' }
    ): ToolCallInfo => {
        const toolCalls = ensureAssistantToolCalls(message);
        const existingToolCall = toolCalls.find((toolCall) => toolCall.id === toolEvent.callId);
        const display = resolveToolDisplayInfo(toolEvent);

        if (existingToolCall) {
            existingToolCall.name = display.displayName;
            existingToolCall.namespacedName = toolEvent.namespacedName;
            existingToolCall.source = display.source;
            existingToolCall.sourceLabel = display.sourceLabel;
            existingToolCall.serverName = display.serverName;
            existingToolCall.serverId = display.serverId;
            existingToolCall.arguments = toolEvent.arguments;
            existingToolCall.builtinConversationSemantic = toolEvent.builtinConversationSemantic;
            if (existingToolCall.status !== 'awaiting_approval') {
                existingToolCall.status = 'executing';
            }
            syncBuiltInToolCallPresentation(existingToolCall);
            return existingToolCall;
        }

        const toolCall: ToolCallInfo = {
            id: toolEvent.callId,
            name: display.displayName,
            namespacedName: toolEvent.namespacedName,
            source: display.source,
            serverName: display.serverName,
            serverId: display.serverId,
            sourceLabel: display.sourceLabel,
            arguments: toolEvent.arguments,
            builtinConversationSemantic: toolEvent.builtinConversationSemantic,
            status: 'executing',
        };
        syncBuiltInToolCallPresentation(toolCall);
        toolCalls.push(toolCall);
        return toolCall;
    };

    const updateToolCallStatus = (
        messageId: string,
        callId: string,
        updater: (toolCall: ToolCallInfo) => void
    ): void => {
        const message = getAssistantMessageById(messageId);
        const toolCall = message?.toolCalls?.find((item) => item.id === callId);

        if (toolCall) {
            updater(toolCall);
            syncBuiltInToolCallPresentation(toolCall);
        }
    };

    const {
        pendingApprovalQueue,
        pendingToolApproval,
        presentToolApproval,
        requestToolApproval,
        settlePendingApproval,
        clearPendingApprovals,
        cleanupApprovalState,
        approvePendingToolApproval,
        rejectPendingToolApproval,
    } = useToolApproval({
        getAssistantMessageById,
        ensureAssistantApprovals,
        ensureApprovalPart,
        updateToolCallStatus,
    });

    const toError = (value: unknown): Error => {
        if (value instanceof Error) {
            return value;
        }

        return new Error(String(value));
    };

    const isCancelledError = (requestError: Error): boolean => {
        return requestError instanceof AiError && requestError.is(AiErrorCode.REQUEST_CANCELLED);
    };

    function resetTransientState() {
        response.value = '';
        reasoning.value = '';
        error.value = null;
        currentTurn.value = null;
        abortController.value = null;
    }

    /**
     * 清空 UI 会话历史。
     */
    function clearConversation() {
        clearPendingApprovals('请求已结束');
        resetWidgetRuntime();
        conversationHistory.value = [];
        currentSessionId.value = null;
        resetTransientState();
    }

    /**
     * 打开一个已持久化的历史会话，并把数据库消息恢复成 UI 对话结构。
     *
     * @param sessionId 会话主键。
     * @returns 会话基础信息，供上层恢复模型标签。
     */
    async function openSession(sessionId: number): Promise<LoadedConversationSession> {
        if (isLoading.value) {
            throw new Error('当前请求尚未结束，无法切换会话');
        }

        const { session, messages, turns, attempts, model }: SessionConversationData =
            await getSessionConversation(sessionId);

        conversationHistory.value = await buildConversationHistory({
            messages,
            turns,
            attempts,
            resolveServerName: (serverId) =>
                serverId === null ? '' : mcpStore.serverNameById(serverId),
        });
        currentSessionId.value = session.id;
        resetWidgetRuntime();
        resetTransientState();

        return {
            sessionId: session.id,
            title: session.title,
            modelId: model?.model_id ?? session.model ?? null,
            providerId: model?.provider_id ?? session.provider_id ?? null,
        };
    }

    /**
     * 触发一次 AI 请求
     */
    async function sendRequest(
        prompt: string,
        attachments: Index[] = [],
        modelId?: string,
        providerId?: number
    ) {
        if (!prompt.trim()) {
            error.value = new Error('Prompt cannot be empty');
            return;
        }

        abortController.value = new AbortController();
        const currentRequestId = ++requestId;
        resetWidgetRuntime();

        isLoading.value = true;
        error.value = null;
        response.value = '';
        reasoning.value = '';

        // 添加用户消息到会话历史
        const userMessageId = crypto.randomUUID();
        conversationHistory.value.push({
            id: userMessageId,
            role: 'user',
            content: prompt,
            attachments: attachments.length > 0 ? attachments : undefined,
            parts: [],
            timestamp: Date.now(),
        });

        // 添加 AI 消息占位符，标记为流式传输状态
        let assistantMsg = createStreamingAssistantMessage();

        // 如果是新会话，预先创建数据库会话
        if (!currentSessionId.value) {
            try {
                const normalized = collapseWhitespace(prompt);
                const title = !normalized ? '新会话' : truncateText(normalized, 40);
                currentSessionId.value = await createSession(
                    title,
                    modelId || '',
                    providerId ?? null
                );
            } catch (sessionError) {
                console.error('[useAiRequest] Failed to pre-create session:', sessionError);
            }
        }

        try {
            const result = await aiService.run({
                prompt,
                sessionId: currentSessionId.value ?? undefined,
                modelId,
                providerId,
                attachments,
                signal: abortController.value.signal,
                requestToolApproval: (payload) => requestToolApproval(assistantMsg.id, payload),
                onChunk: (chunk) => {
                    if (chunk.toolEvent?.type === 'request_retry') {
                        const shouldKeepAssistantMessage = hasVisibleAssistantContent(assistantMsg);

                        if (shouldKeepAssistantMessage) {
                            assistantMsg.isStreaming = false;
                        } else {
                            removeConversationMessageById(assistantMsg.id);
                        }

                        response.value = '';
                        reasoning.value = '';
                        conversationHistory.value.push(
                            createDerivedStatusMessage(
                                getRetryStatusMessage(
                                    chunk.toolEvent.attempt,
                                    chunk.toolEvent.maxRetries
                                ),
                                {
                                    isRetrying: true,
                                }
                            )
                        );
                        assistantMsg = createStreamingAssistantMessage();
                        return;
                    }

                    if (chunk.reasoning) {
                        reasoning.value += chunk.reasoning;
                        assistantMsg.reasoning = reasoning.value;
                    }

                    if (chunk.content) {
                        response.value += chunk.content;
                        assistantMsg.content = response.value;
                        const lastPart = assistantMsg.parts[assistantMsg.parts.length - 1];
                        if (lastPart && lastPart.type === 'text') {
                            lastPart.content += chunk.content;
                        } else {
                            assistantMsg.parts.push(createTextPart(chunk.content));
                        }

                        options.onChunk?.(chunk.content);
                    }

                    if (chunk.toolCallDeltas) {
                        for (const toolCallDelta of chunk.toolCallDeltas) {
                            handleToolCallDelta(assistantMsg.id, toolCallDelta);
                        }
                    }

                    if (chunk.done && chunk.toolCalls) {
                        for (const toolCall of chunk.toolCalls) {
                            upsertShowWidgetDraftFromFinalToolCall(assistantMsg.id, toolCall);
                        }
                    }

                    // 处理工具调用事件
                    if (chunk.toolEvent) {
                        const toolEvent = chunk.toolEvent as ExtendedToolEvent;

                        if (toolEvent.type === 'call_start') {
                            upsertToolCall(assistantMsg, toolEvent);
                            if (!isHiddenBuiltinToolCall(toolEvent.namespacedName)) {
                                ensureToolCallPart(assistantMsg, toolEvent.callId);
                            }
                        } else if (toolEvent.type === 'approval_required') {
                            presentToolApproval(assistantMsg.id, {
                                callId: toolEvent.callId,
                                title: toolEvent.title,
                                description: toolEvent.description,
                                command: toolEvent.command,
                                riskLabel: toolEvent.riskLabel,
                                reason: toolEvent.reason,
                                commandLabel: toolEvent.commandLabel,
                                approveLabel: toolEvent.approveLabel,
                                rejectLabel: toolEvent.rejectLabel,
                                enterHint: toolEvent.enterHint,
                                escHint: toolEvent.escHint,
                                keyboardApproveDelayMs: toolEvent.keyboardApproveDelayMs,
                            });
                        } else if (toolEvent.type === 'approval_resolved') {
                            settlePendingApproval(toolEvent.callId, toolEvent.approved, {
                                resolutionText: toolEvent.resolutionText,
                            });
                        } else if (toolEvent.type === 'widget_upsert') {
                            upsertWidget(assistantMsg.id, toolEvent);
                        } else if (toolEvent.type === 'widget_remove') {
                            removeWidgetByWidgetId(toolEvent.widgetId, assistantMsg.id);
                        } else if (toolEvent.type === 'call_end') {
                            finalizeToolCall(toolEvent.callId, {
                                removeDraft:
                                    toolEvent.isError || toolEvent.finalStatus === 'rejected',
                            });
                            updateToolCallStatus(assistantMsg.id, toolEvent.callId, (toolCall) => {
                                toolCall.result = toolEvent.result;
                                toolCall.isError = toolEvent.isError;
                                if (toolEvent.finalStatus === 'rejected') {
                                    toolCall.status = 'rejected';
                                } else {
                                    toolCall.status = toolEvent.isError ? 'error' : 'completed';
                                }
                                toolCall.durationMs = toolEvent.durationMs;
                            });
                            cleanupApprovalState(toolEvent.callId);
                        } else if (toolEvent.type === 'model_switched') {
                            options.onModelSelected?.({
                                modelId: toolEvent.toModel.modelId,
                                providerId: toolEvent.toModel.providerId,
                            });
                        }
                    }
                },
            });

            // 标记 AI 消息为完成状态
            assistantMsg.isStreaming = false;

            currentTurn.value = result.turn;
            options.onComplete?.(result.response);
        } catch (rawError) {
            const requestError = toError(rawError);

            if (isCancelledError(requestError)) {
                const shouldKeepAssistantMessage = hasVisibleAssistantContent(assistantMsg);
                // 如果是第一次请求就取消（只有用户消息和一个未完成的 AI 消息）
                if (conversationHistory.value.length === 2 && !shouldKeepAssistantMessage) {
                    // 清空会话历史
                    conversationHistory.value = [];
                    currentSessionId.value = null;
                } else {
                    if (!shouldKeepAssistantMessage) {
                        // 如果没有内容，移除未完成的 AI 消息
                        removeConversationMessageById(assistantMsg.id);
                    } else {
                        // 保留已有内容，停止流式传输
                        assistantMsg.isStreaming = false;
                    }

                    // 追加取消提示
                    conversationHistory.value.push(
                        createDerivedStatusMessage('请求已取消', {
                            isCancelled: true,
                        })
                    );
                }
                // 取消错误不设置 error.value，避免显示错误提示
                return;
            }

            error.value = requestError;

            const shouldKeepAssistantMessage = hasVisibleAssistantContent(assistantMsg);
            if (shouldKeepAssistantMessage) {
                assistantMsg.isStreaming = false;
            } else {
                removeConversationMessageById(assistantMsg.id);
            }

            conversationHistory.value.push(
                createDerivedStatusMessage(`请求失败: ${requestError.message}`, {
                    isError: true,
                })
            );

            const isEmptyResponse =
                requestError instanceof AiError && requestError.is(AiErrorCode.EMPTY_RESPONSE);

            try {
                sendNotification({
                    title: isEmptyResponse ? 'TouchAI - 空回复' : 'TouchAI - 请求失败',
                    body: requestError.message || '未知错误',
                });
            } catch (notificationError) {
                console.error('[useAiRequest] Failed to send notification:', notificationError);
            }

            options.onError?.(requestError);
        } finally {
            clearPendingApprovals('请求已结束');
            resetWidgetRuntime();
            if (currentRequestId === requestId) {
                isLoading.value = false;
            }
        }
    }

    /**
     * 重置 UI 状态。
     */
    function reset() {
        resetWidgetRuntime();
        clearPendingApprovals('请求已重置');
        isLoading.value = false;
        resetTransientState();
    }

    /**
     * 取消当前请求并清理 UI 状态。
     */
    function cancel() {
        if (abortController.value) {
            clearPendingApprovals('请求已取消');
            abortController.value.abort();
            reset();
        }
    }

    return {
        isLoading,
        error,
        response,
        reasoning,
        hasError,
        hasResponse,
        sendRequest,
        reset,
        cancel,
        openSession,
        // 会话管理
        currentSessionId,
        conversationHistory,
        clearConversation,
        pendingToolApproval,
        pendingApprovalQueue,
        approvePendingToolApproval,
        rejectPendingToolApproval,
    };
}
