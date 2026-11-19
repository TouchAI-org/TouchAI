// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { computed, onUnmounted, ref } from 'vue';

import type {
    AskUserAnswer,
    AttachmentReference as Index,
    InputHistorySnapshot,
    PendingUserMessage,
    PendingUserMessageDelivery,
    PendingUserMessageInput,
    SessionInformation as LoadedSessionInfo,
} from '@/app/api/agent';
import { useAgentApi } from '@/app/api/agent';
import { AiError, AiErrorCode } from '@/app/api/agent/errors';
import { AppEvent, eventService } from '@/app/api/agent/events';
import { log } from '@/app/api/diagnostics';
import { notify } from '@/app/api/windows/notifications';
import { t } from '@/i18n';

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
    const agent = useAgentApi();
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
        const observationId = requestId;
        const [loaded, restoredPendingMessages] = await Promise.all([
            agent.loadSession(sessionId),
            agent.restoreSessionQueue(sessionId),
        ]);
        if (observationId === requestId) {
            sessionHistory.value = loaded.history;
            currentSessionId.value = loaded.sessionId;
            pendingUserMessages.value = restoredPendingMessages;
            resetTransientState();
            agent.resumeSessionQueue(sessionId);
        }

        return {
            sessionId: loaded.sessionId,
            title: loaded.title,
            modelId: loaded.modelId,
            providerId: loaded.providerId,
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

        const activeTask = agent.attachSessionView(sessionId);
        if (activeTask) {
            attachTaskView(activeTask.taskId, activeTask.snapshot);
            const session = await agent.getSession(sessionId);
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
            const startedTask = await agent.startTask({
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

        agent.cancelTask(attachedTaskId.value);
    }

    /**
     * 批准等待中的工具调用。
     */
    function approvePendingToolApproval(callId?: string, decisionId?: string): boolean {
        if (!attachedTaskId.value) {
            return false;
        }

        return agent.approveTaskToolCall(attachedTaskId.value, callId, decisionId);
    }

    /**
     * 拒绝等待中的工具调用。
     */
    function rejectPendingToolApproval(callId?: string, decisionId?: string): boolean {
        if (!attachedTaskId.value) {
            return false;
        }

        return agent.rejectTaskToolCall(attachedTaskId.value, callId, decisionId);
    }

    function settleUserQuestion(
        callId: string,
        answers: AskUserAnswer[] | null,
        decisionId?: string
    ): boolean {
        if (!attachedTaskId.value) {
            return false;
        }
        return agent.settleTaskUserQuestion(attachedTaskId.value, callId, answers, decisionId);
    }

    function enqueueUserMessage(
        input: PendingUserMessageInput,
        delivery: PendingUserMessageDelivery
    ): PendingUserMessage | null {
        if (attachedTaskId.value) {
            const message = agent.enqueueTaskUserMessage(attachedTaskId.value, input, delivery);
            if (message) {
                return message;
            }
        }

        // 上一轮结束到下一条排队任务挂载之间，页面还没有 attachedTaskId，
        // 但会话已经有待发队列。这里写回会话队列，避免这条消息被当成新请求。
        if (currentSessionId.value === null) {
            return null;
        }
        return agent.enqueueSessionUserMessage(currentSessionId.value, input, delivery);
    }

    function removePendingUserMessage(messageId: string): boolean {
        if (attachedTaskId.value && agent.removeTaskUserMessage(attachedTaskId.value, messageId)) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : agent.removeSessionUserMessage(currentSessionId.value, messageId);
    }

    function updatePendingUserMessage(messageId: string, input: PendingUserMessageInput): boolean {
        if (
            attachedTaskId.value &&
            agent.updateTaskUserMessage(attachedTaskId.value, messageId, input)
        ) {
            return true;
        }
        // A run can finish while the user is editing a queued message. The
        // message may already belong to the session hand-over queue even
        // though the page still holds the previous task id.
        return currentSessionId.value !== null
            ? agent.updateSessionUserMessage(currentSessionId.value, messageId, input)
            : false;
    }

    function setPendingUserMessageEditing(messageId: string, editing: boolean): boolean {
        if (
            attachedTaskId.value &&
            agent.setTaskUserMessageEditing(attachedTaskId.value, messageId, editing)
        ) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : agent.setSessionUserMessageEditing(currentSessionId.value, messageId, editing);
    }

    function beginPendingMessageEdit(messageId: string): boolean {
        return setPendingUserMessageEditing(messageId, true);
    }

    function endPendingMessageEdit(messageId: string): boolean {
        if (setPendingUserMessageEditing(messageId, false)) {
            return true;
        }
        // The page may have switched sessions while the composer still held an
        // edit. Clear the flag at its owning task or hand-over queue instead of
        // leaving that message permanently excluded from delivery.
        return agent.clearUserMessageEditing(messageId);
    }

    function promotePendingUserMessage(messageId: string): boolean {
        if (attachedTaskId.value && agent.promoteTaskUserMessage(attachedTaskId.value, messageId)) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : agent.promoteSessionUserMessage(currentSessionId.value, messageId);
    }

    function reorderPendingUserMessages(orderedQueueIds: string[]): boolean {
        if (
            attachedTaskId.value &&
            agent.reorderTaskQueuedMessages(attachedTaskId.value, orderedQueueIds)
        ) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : agent.reorderSessionQueuedMessages(currentSessionId.value, orderedQueueIds);
    }

    function clearPendingUserMessages(): boolean {
        if (attachedTaskId.value && agent.clearTaskUserMessages(attachedTaskId.value)) {
            return true;
        }
        return currentSessionId.value === null
            ? false
            : agent.clearSessionUserMessages(currentSessionId.value);
    }

    function updatePendingUserMessagesModel(
        modelId: string | null,
        providerId: number | null
    ): boolean {
        if (!attachedTaskId.value) {
            return false;
        }
        return agent.updateTaskUserMessageModel(attachedTaskId.value, modelId, providerId);
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

            const activeTask = agent.attachSessionView(event.sessionId);
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
        beginPendingMessageEdit,
        endPendingMessageEdit,
        reorderPendingUserMessages,
        clearPendingUserMessages,
        updatePendingUserMessagesModel,
    };
}
