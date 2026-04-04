// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findSessionById } from '@database/queries/sessions';
import type { SessionTurn } from '@database/schema';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { computed, onUnmounted, ref } from 'vue';

import { sessionTaskCenter } from '@/services/AgentService';
import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { type Index } from '@/services/AgentService/infrastructure/attachments';
import { buildSessionHistoryFromData } from '@/services/AgentService/session';
import { getSessionData } from '@/services/AgentService/session';
import type { LoadedSessionInfo } from '@/types/session';

import { useAgentState } from './useAgentState';

export interface UseAiRequestOptions {
    sessionId?: number;
    onChunk?: (content: string) => void;
    onComplete?: (response: string) => void;
    onError?: (error: Error) => void;
    onModelSelected?: (target: { modelId: string; providerId: number }) => void;
}

/**
 * 判断错误是否属于用户主动取消。
 */
function isCancelledError(requestError: Error): boolean {
    return requestError instanceof AiError && requestError.is(AiErrorCode.REQUEST_CANCELLED);
}

/**
 * `useAgent` 只负责页面命令：
 * - 发起前台任务
 * - 在切换会话时决定挂回活跃任务还是回放持久化历史
 * - 把任务视图层状态重新整理为页面可直接消费的接口
 */
export function useAgent(options: UseAiRequestOptions = {}) {
    const currentTurn = ref<SessionTurn | null>(null);
    const isStartingTask = ref(false);

    const {
        isLoading: isTaskLoading,
        error,
        response,
        reasoning,
        currentSessionId,
        sessionHistory,
        attachedTaskId,
        pendingToolApproval,
        pendingApprovalQueue,
        attachTaskView,
        detachTaskView,
        resetTaskViewState,
    } = useAgentState({
        onChunk: options.onChunk,
        onModelSelected: options.onModelSelected,
    });

    const isLoading = computed(() => isStartingTask.value || isTaskLoading.value);
    const hasError = computed(() => error.value !== null);
    const hasResponse = computed(() => response.value.length > 0);

    let requestId = 0;
    let startingRequestId: number | null = null;
    let startupAbortController: AbortController | null = null;

    /**
     * 判断当前页面是否仍然观察着指定任务。
     */
    function isStillObservingTask(taskId: string | null): boolean {
        return !!taskId && attachedTaskId.value === taskId;
    }

    /**
     * 标记任务正处于启动阶段。
     */
    function markTaskStartPending(currentRequestId: number, controller: AbortController) {
        startingRequestId = currentRequestId;
        startupAbortController = controller;
        isStartingTask.value = true;
    }

    /**
     * 清除任务启动阶段的等待状态。
     */
    function clearTaskStartPending(currentRequestId: number) {
        if (startingRequestId !== currentRequestId) {
            return;
        }

        startingRequestId = null;
        startupAbortController = null;
        isStartingTask.value = false;
    }

    /**
     * 让当前页面停止接收旧请求的后续结果。
     */
    function invalidateRequestObservation() {
        // 页面一旦切会话、清空或卸载，旧请求后续即使完成，
        // 也不应该再驱动当前页面的 onComplete / onError 链路。
        requestId += 1;
        startingRequestId = null;
        startupAbortController = null;
        isStartingTask.value = false;
        currentTurn.value = null;
    }

    /**
     * 重置当前页面的瞬时状态。
     */
    function resetTransientState() {
        resetTaskViewState();
        currentTurn.value = null;
    }

    /**
     * 从持久化数据恢复指定会话。
     */
    async function loadPersistedSession(sessionId: number): Promise<LoadedSessionInfo> {
        const { session, messages, turns, attempts, model } = await getSessionData(sessionId);
        sessionHistory.value = await buildSessionHistoryFromData({
            messages,
            turns,
            attempts,
        });
        currentSessionId.value = session.id;
        resetTransientState();

        return {
            sessionId: session.id,
            title: session.title,
            modelId: model?.model_id ?? session.model ?? null,
            providerId: model?.provider_id ?? session.provider_id ?? null,
        };
    }

    /**
     * 清空当前页面观察状态。
     *
     * 如果当前任务仍在运行，它会继续留在任务中心后台执行。
     */
    function clearSession() {
        invalidateRequestObservation();
        detachTaskView();
        sessionHistory.value = [];
        currentSessionId.value = null;
        resetTransientState();
    }

    /**
     * 打开会话，优先复用仍在运行的任务视图。
     */
    async function openSession(sessionId: number): Promise<LoadedSessionInfo> {
        invalidateRequestObservation();

        const activeTask = sessionTaskCenter.attachSessionView(sessionId);
        if (activeTask) {
            attachTaskView(activeTask.taskId, activeTask.snapshot);
            const session = await findSessionById(sessionId);
            return {
                sessionId,
                title: session?.title ?? '',
                modelId: activeTask.snapshot.currentModel?.modelId ?? null,
                providerId: activeTask.snapshot.currentModel?.providerId ?? null,
            };
        }

        detachTaskView();
        return loadPersistedSession(sessionId);
    }

    /**
     * 发起前台请求并挂接到新任务。
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

        const currentRequestId = ++requestId;
        const startAbortController = new AbortController();
        let startedTaskId: string | null = null;

        error.value = null;
        response.value = '';
        reasoning.value = '';
        currentTurn.value = null;
        markTaskStartPending(currentRequestId, startAbortController);

        try {
            const startedTask = await sessionTaskCenter.startTask({
                prompt,
                sessionId: currentSessionId.value ?? undefined,
                modelId,
                providerId,
                attachments,
                executionMode: 'foreground',
                signal: startAbortController.signal,
            });
            startedTaskId = startedTask.taskId;

            // `startTask()` 期间用户可能已经切页或清空，此时不再把旧任务重新挂回当前页面。
            if (currentRequestId !== requestId) {
                clearTaskStartPending(currentRequestId);
                return;
            }

            attachTaskView(startedTaskId);
            clearTaskStartPending(currentRequestId);

            const result = await startedTask.completion;
            if (currentRequestId === requestId && isStillObservingTask(startedTaskId)) {
                currentTurn.value = result.turn;
                options.onComplete?.(result.response);
            }
        } catch (rawError) {
            clearTaskStartPending(currentRequestId);

            const requestError = rawError instanceof Error ? rawError : new Error(String(rawError));
            if (currentRequestId !== requestId) {
                return;
            }

            if (startedTaskId && !isStillObservingTask(startedTaskId)) {
                return;
            }

            if (isCancelledError(requestError)) {
                return;
            }

            error.value = requestError;

            const isEmptyResponse =
                requestError instanceof AiError && requestError.is(AiErrorCode.EMPTY_RESPONSE);

            try {
                sendNotification({
                    title: isEmptyResponse ? 'TouchAI - 空回复' : 'TouchAI - 请求失败',
                    body: requestError.message || '未知错误',
                });
            } catch (notificationError) {
                console.error('[useAgent] Failed to send notification:', notificationError);
            }

            options.onError?.(requestError);
        }
    }

    /**
     * 重置页面的瞬时响应内容。
     */
    function reset() {
        resetTransientState();
    }

    /**
     * 取消当前启动中或运行中的任务。
     */
    function cancel() {
        if (!attachedTaskId.value) {
            if (startupAbortController) {
                startupAbortController.abort();
            }
            return;
        }

        sessionTaskCenter.cancelTask(attachedTaskId.value);
    }

    /**
     * 批准等待中的工具调用。
     */
    function approvePendingToolApproval(callId?: string): boolean {
        if (!attachedTaskId.value) {
            return false;
        }

        return sessionTaskCenter.approveTaskToolCall(attachedTaskId.value, callId);
    }

    /**
     * 拒绝等待中的工具调用。
     */
    function rejectPendingToolApproval(callId?: string): boolean {
        if (!attachedTaskId.value) {
            return false;
        }

        return sessionTaskCenter.rejectTaskToolCall(attachedTaskId.value, callId);
    }

    onUnmounted(() => {
        invalidateRequestObservation();
        detachTaskView();
    });

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
        currentSessionId,
        sessionHistory,
        clearSession,
        pendingToolApproval,
        pendingApprovalQueue,
        approvePendingToolApproval,
        rejectPendingToolApproval,
    };
}
