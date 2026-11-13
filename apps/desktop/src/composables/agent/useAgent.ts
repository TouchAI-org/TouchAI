// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findSessionById } from '@database/queries/sessions';
import { notify } from '@services/NotificationService';
import { log } from '@services/ObservabilityService';
import { computed, onUnmounted, ref } from 'vue';

import { t } from '@/i18n';
import {
    type PendingUserMessage,
    type PendingUserMessageDelivery,
    type PendingUserMessageInput,
    sessionTaskCenter,
} from '@/services/AgentService';
import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { type Index } from '@/services/AgentService/infrastructure/attachments';
import { loadCompleteSessionHistory } from '@/services/AgentService/session';
import { eventService } from '@/services/EventService';
import { AppEvent } from '@/services/EventService/types';
import type { InputHistorySnapshot, LoadedSessionInfo } from '@/types/session';

import { useAgentState } from './useAgentState';

export interface UseAiRequestOptions {
    sessionId?: number;
    onChunk?: (content: string) => void;
    onComplete?: (response: string) => void;
    onError?: (error: Error) => void;
    onModelSelected?: (target: { modelId: string; providerId: number }) => void;
    onTurnStarted?: (target: { sessionId: number; turnId: number }) => void;
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
    const isStartingTask = ref(false);

    const {
        isLoading: isTaskLoading,
        error,
        response,
        reasoning,
        currentSessionId,
        sessionHistory,
        attachedTaskId,
        pendingUserMessages,
        pendingToolApproval,
        pendingApprovalQueue,
        pendingUserQuestion,
        attachTaskView,
        detachTaskView,
        resetTaskViewState,
    } = useAgentState({
        onChunk: options.onChunk,
        onModelSelected: options.onModelSelected,
        onTurnStarted: options.onTurnStarted,
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

    function abortTaskStartPending() {
        const controller = startupAbortController;

        startingRequestId = null;
        startupAbortController = null;
        isStartingTask.value = false;
        controller?.abort();
    }

    /**
     * 让当前页面停止接收旧请求的后续结果。
     */
    function invalidateRequestObservation() {
        // 页面一旦切会话、清空或卸载，旧请求后续即使完成，
        // 也不应该再驱动当前页面的 onComplete / onError 链路。
        requestId += 1;
        abortTaskStartPending();
    }

    /**
     * 重置当前页面的瞬时状态。
     */
    function resetTransientState() {
        resetTaskViewState();
    }

    /**
     * 从持久化数据恢复指定会话。
     *
     * 一次读完整个会话：展示层不分页，滚动条高度与时间轴定位才是真实值；
     * 长会话的渲染开销由布界挂载（窗口化）控制，不会随消息数线性增长 DOM。
     */
    async function loadPersistedSession(sessionId: number): Promise<LoadedSessionInfo> {
        const loaded = await loadCompleteSessionHistory(sessionId);
        sessionHistory.value = loaded.history;
        currentSessionId.value = loaded.session.id;
        resetTransientState();

        return {
            sessionId: loaded.session.id,
            title: loaded.session.title,
            modelId: loaded.model?.model_id ?? loaded.session.model ?? null,
            providerId: loaded.model?.provider_id ?? loaded.session.provider_id ?? null,
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

        if (attachedTaskId.value !== null) {
            // 切到静态会话前先真正解开旧任务订阅，避免旧会话的后续流式更新把页面抢回去。
            detachTaskView({ preserveSession: true });
        }

        return loadPersistedSession(sessionId);
    }

    /**
     * 发起前台请求并挂接到新任务。
     */
    async function sendRequest(
        prompt: string,
        attachments: Index[] = [],
        inputSnapshot?: InputHistorySnapshot,
        modelId?: string,
        providerId?: number
    ) {
        if (!prompt.trim() && attachments.length === 0 && !inputSnapshot?.skills?.length) {
            error.value = new Error(t('search.error.promptEmpty'));
            return;
        }

        const currentRequestId = ++requestId;
        const startAbortController = new AbortController();
        let startedTaskId: string | null = null;

        error.value = null;
        response.value = '';
        reasoning.value = '';
        markTaskStartPending(currentRequestId, startAbortController);

        try {
            const startedTask = await sessionTaskCenter.startTask({
                prompt,
                sessionId: currentSessionId.value ?? undefined,
                modelId,
                providerId,
                attachments,
                inputSnapshot,
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

            error.value =
                requestError instanceof AiError
                    ? new Error(requestError.getDisplayMessage())
                    : requestError;

            const isEmptyResponse =
                requestError instanceof AiError && requestError.is(AiErrorCode.EMPTY_RESPONSE);
            const displayMessage = AiError.getDisplayMessage(requestError);

            if (!startedTaskId) {
                try {
                    notify({
                        title: t(
                            isEmptyResponse
                                ? 'notification.search.emptyResponseTitle'
                                : 'notification.search.requestFailedTitle'
                        ),
                        body: displayMessage || t('common.unknownError'),
                    });
                } catch (notificationError) {
                    log.error('[useAgent] Failed to send notification:', notificationError);
                }
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
                requestId += 1;
                abortTaskStartPending();
            }
            return;
        }

        sessionTaskCenter.cancelTask(attachedTaskId.value);
    }

    /**
     * 批准等待中的工具调用。
     */
    function approvePendingToolApproval(callId?: string, decisionId?: string): boolean {
        if (!attachedTaskId.value) {
            return false;
        }

        return sessionTaskCenter.approveTaskToolCall(attachedTaskId.value, callId, decisionId);
    }

    /**
     * 拒绝等待中的工具调用。
     */
    function rejectPendingToolApproval(callId?: string, decisionId?: string): boolean {
        if (!attachedTaskId.value) {
            return false;
        }

        return sessionTaskCenter.rejectTaskToolCall(attachedTaskId.value, callId, decisionId);
    }

    function settleUserQuestion(
        callId: string,
        answers: import('@/services/AgentService/contracts/tooling').AskUserAnswer[] | null,
        decisionId?: string
    ): boolean {
        if (!attachedTaskId.value) {
            return false;
        }
        return sessionTaskCenter.settleTaskUserQuestion(
            attachedTaskId.value,
            callId,
            answers,
            decisionId
        );
    }

    function enqueueUserMessage(
        input: PendingUserMessageInput,
        delivery: PendingUserMessageDelivery
    ): PendingUserMessage | null {
        if (attachedTaskId.value) {
            const message = sessionTaskCenter.enqueueTaskUserMessage(
                attachedTaskId.value,
                input,
                delivery
            );
            if (message) {
                return message;
            }
        }

        // 上一轮结束到下一条排队任务挂载之间，页面还没有 attachedTaskId，
        // 但会话已经有待发队列。这里写回会话队列，避免这条消息被当成新请求。
        if (currentSessionId.value === null) {
            return null;
        }
        return sessionTaskCenter.enqueueSessionUserMessage(currentSessionId.value, input, delivery);
    }

    function removePendingUserMessage(messageId: string): boolean {
        if (
            attachedTaskId.value &&
            sessionTaskCenter.removeTaskUserMessage(attachedTaskId.value, messageId)
        ) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : sessionTaskCenter.removeSessionUserMessage(currentSessionId.value, messageId);
    }

    function updatePendingUserMessage(messageId: string, input: PendingUserMessageInput): boolean {
        if (
            attachedTaskId.value &&
            sessionTaskCenter.updateTaskUserMessage(attachedTaskId.value, messageId, input)
        ) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : sessionTaskCenter.updateSessionUserMessage(currentSessionId.value, messageId, input);
    }

    function promotePendingUserMessage(messageId: string): boolean {
        if (
            attachedTaskId.value &&
            sessionTaskCenter.promoteTaskUserMessage(attachedTaskId.value, messageId)
        ) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : sessionTaskCenter.promoteSessionUserMessage(currentSessionId.value, messageId);
    }

    function reorderPendingUserMessages(orderedQueueIds: string[]): boolean {
        if (
            attachedTaskId.value &&
            sessionTaskCenter.reorderTaskQueuedMessages(attachedTaskId.value, orderedQueueIds)
        ) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : sessionTaskCenter.reorderSessionQueuedMessages(
                  currentSessionId.value,
                  orderedQueueIds
              );
    }

    function clearPendingUserMessages(): boolean {
        if (attachedTaskId.value && sessionTaskCenter.clearTaskUserMessages(attachedTaskId.value)) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : sessionTaskCenter.clearSessionUserMessages(currentSessionId.value);
    }

    function updatePendingUserMessagesModel(
        modelId: string | null,
        providerId: number | null
    ): boolean {
        if (!attachedTaskId.value) {
            return false;
        }
        return sessionTaskCenter.updateTaskUserMessageModel(
            attachedTaskId.value,
            modelId,
            providerId
        );
    }

    let stopSessionTaskListener: (() => void) | null = null;
    let sessionTaskListenerDisposed = false;
    void eventService
        .on(AppEvent.SESSION_TASK_STATUS_CHANGED, (event) => {
            if (
                event.sessionId === null ||
                event.sessionId !== currentSessionId.value ||
                (event.status !== 'running' && event.status !== 'waiting_approval') ||
                attachedTaskId.value === event.taskId
            ) {
                return;
            }

            const activeTask = sessionTaskCenter.attachSessionView(event.sessionId);
            if (activeTask?.taskId === event.taskId) {
                attachTaskView(activeTask.taskId, activeTask.snapshot);
            }
        })
        .then((unlisten) => {
            if (sessionTaskListenerDisposed) {
                unlisten();
                return;
            }
            stopSessionTaskListener = unlisten;
        })
        .catch((error) => {
            log.error('[useAgent] Failed to follow a queued session task:', error);
        });

    onUnmounted(() => {
        sessionTaskListenerDisposed = true;
        stopSessionTaskListener?.();
        stopSessionTaskListener = null;
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
        pendingUserMessages,
        clearSession,
        pendingToolApproval,
        pendingApprovalQueue,
        pendingUserQuestion,
        approvePendingToolApproval,
        rejectPendingToolApproval,
        settleUserQuestion,
        enqueueUserMessage,
        promotePendingUserMessage,
        removePendingUserMessage,
        updatePendingUserMessage,
        reorderPendingUserMessages,
        clearPendingUserMessages,
        updatePendingUserMessagesModel,
    };
}
