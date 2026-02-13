// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiRequest } from '@database/schema';
import { aiService } from '@services/AiService';
import type { Index } from '@services/AiService/attachments';
import { AiError, AiErrorCode } from '@services/AiService/errors';
import { createSession } from '@services/AiService/session';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { computed, ref } from 'vue';

export interface ConversationMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    attachments?: Index[];
    timestamp: number;
    isStreaming?: boolean;
    isCancelled?: boolean; // 标记是否为取消的消息
}

export interface UseAiRequestOptions {
    sessionId?: number;
    onChunk?: (content: string) => void;
    onComplete?: (response: string) => void;
    onError?: (error: Error) => void;
}

/**
 * 负责AI请求前端交互和状态管理：
 * - 控制加载态、错误态、响应内容
 * - 发起业务请求到 AiService
 * - 转发 UI 层回调
 * - 管理会话历史和超时清理
 */
export function useAiRequest(options: UseAiRequestOptions = {}) {
    const isLoading = ref(false);
    const error = ref<Error | null>(null);
    const response = ref('');
    const reasoning = ref('');
    const currentRequest = ref<AiRequest | null>(null);
    const abortController = ref<AbortController | null>(null);
    let requestId = 0;

    // 会话数据
    const currentSessionId = ref<number | null>(options.sessionId ?? null);
    const conversationHistory = ref<ConversationMessage[]>([]);

    const hasError = computed(() => error.value !== null);
    const hasResponse = computed(() => response.value.length > 0);

    const toError = (value: unknown): Error => {
        if (value instanceof Error) {
            return value;
        }

        return new Error(String(value));
    };

    const isCancelledError = (requestError: Error): boolean => {
        return requestError instanceof AiError && requestError.is(AiErrorCode.REQUEST_CANCELLED);
    };

    /**
     * 清空UI会话历史
     */
    function clearConversation() {
        conversationHistory.value = [];
        currentSessionId.value = null;
        response.value = '';
        reasoning.value = '';
        error.value = null;
        currentRequest.value = null;
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
            timestamp: Date.now(),
        });

        // 添加 AI 消息占位符，标记为流式传输状态
        const assistantMessageId = crypto.randomUUID();
        conversationHistory.value.push({
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            isStreaming: true,
        });

        const assistantMsg = conversationHistory.value[conversationHistory.value.length - 1]!;

        // 如果是新会话，预先创建数据库会话
        if (!currentSessionId.value) {
            try {
                const normalized = prompt.trim().replace(/\s+/g, ' ');
                const title = !normalized
                    ? '新会话'
                    : normalized.length <= 40
                      ? normalized
                      : `${normalized.slice(0, 40)}...`;
                currentSessionId.value = await createSession(title, modelId || '');
            } catch (e) {
                console.error('[useAiRequest] Failed to pre-create session:', e);
            }
        }

        try {
            const result = await aiService.executeRequest({
                prompt,
                sessionId: currentSessionId.value ?? undefined,
                modelId,
                providerId,
                attachments,
                signal: abortController.value.signal,
                onChunk: (chunk) => {
                    if (chunk.reasoning) {
                        reasoning.value += chunk.reasoning;
                        assistantMsg.reasoning = reasoning.value;
                    }

                    if (chunk.content) {
                        response.value += chunk.content;
                        assistantMsg.content = response.value;
                        options.onChunk?.(chunk.content);
                    }
                },
            });

            // 标记 AI 消息为完成状态
            assistantMsg.isStreaming = false;

            currentRequest.value = result.request;
            options.onComplete?.(result.response);
        } catch (rawError) {
            const requestError = toError(rawError);

            if (isCancelledError(requestError)) {
                // 如果是第一次请求就取消（只有用户消息和一个未完成的 AI 消息）
                if (conversationHistory.value.length === 2) {
                    // 清空会话历史
                    conversationHistory.value = [];
                    currentSessionId.value = null;
                } else {
                    if (!assistantMsg.content.trim()) {
                        // 如果没有内容，移除未完成的 AI 消息
                        conversationHistory.value = conversationHistory.value.filter(
                            (msg) => msg.id !== assistantMessageId
                        );
                    } else {
                        // 保留已有内容，停止流式传输
                        assistantMsg.isStreaming = false;
                    }

                    // 追加取消提示
                    conversationHistory.value.push({
                        id: crypto.randomUUID(),
                        role: 'assistant',
                        content: '请求已取消',
                        timestamp: Date.now(),
                        isStreaming: false,
                        isCancelled: true,
                    });
                }
                // 取消错误不设置 error.value，避免显示错误提示
                return;
            }

            error.value = requestError;

            // 标记 AI 消息为失败状态（不是取消的情况）
            if (!assistantMsg.isCancelled) {
                assistantMsg.isStreaming = false;
                assistantMsg.content = `请求失败: ${requestError.message}`;
            }

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
            if (currentRequestId === requestId) {
                isLoading.value = false;
            }
        }
    }

    /**
     * 重置 UI 状态。
     */
    function reset() {
        isLoading.value = false;
        error.value = null;
        response.value = '';
        reasoning.value = '';
        currentRequest.value = null;
        abortController.value = null;
    }

    /**
     * 取消当前请求并清理 UI 状态。
     */
    function cancel() {
        if (abortController.value) {
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
        // 会话管理
        currentSessionId,
        conversationHistory,
        clearConversation,
    };
}
