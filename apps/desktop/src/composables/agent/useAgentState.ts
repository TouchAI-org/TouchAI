// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { computed, onUnmounted, ref } from 'vue';

import { sessionTaskCenter, type SessionTaskViewSnapshot } from '@/services/AgentService';
import type { SessionMessage } from '@/types/session';

export interface UseAgentStateOptions {
    onChunk?: (content: string) => void;
    onModelSelected?: (target: { modelId: string; providerId: number }) => void;
    onTurnStarted?: (target: { sessionId: number; turnId: number }) => void;
}

interface DetachTaskViewOptions {
    preserveSession?: boolean;
}

/**
 * 提取最近一条有效 assistant 输出。
 */
function extractLatestAssistantBuffers(history: SessionMessage[]): {
    response: string;
    reasoning: string;
} {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role !== 'assistant') {
            continue;
        }

        if (message.isError || message.isCancelled || message.isRetrying) {
            continue;
        }

        return {
            response: message.content,
            reasoning: message.reasoning ?? '',
        };
    }

    return {
        response: '',
        reasoning: '',
    };
}

/**
 * Agent 任务状态层：
 * - 订阅任务快照
 * - 把任务快照投影成页面可直接消费的响应式状态
 * - 不负责发起任务，也不负责持久化会话恢复
 */
export function useAgentState(options: UseAgentStateOptions = {}) {
    const isLoading = ref(false);
    const error = ref<Error | null>(null);
    const response = ref('');
    const reasoning = ref('');
    const currentSessionId = ref<number | null>(null);
    const sessionHistory = ref<SessionMessage[]>([]);
    const attachedTaskId = ref<string | null>(null);
    const taskStatus = ref<SessionTaskViewSnapshot['status'] | null>(null);
    const currentModel = ref<SessionTaskViewSnapshot['currentModel']>(null);
    const pendingToolApproval = ref<SessionTaskViewSnapshot['pendingToolApproval']>(null);
    const pendingApprovalQueue = ref<SessionTaskViewSnapshot['pendingApprovals']>([]);
    const pendingUserQuestion = ref<SessionTaskViewSnapshot['pendingUserQuestion']>(null);
    // 历史分页：首屏只加载最新一页，向前加载时记录游标。
    const hasOlderHistory = ref(false);
    const oldestLoadedMessageId = ref<number | null>(null);
    const isLoadingOlderHistory = ref(false);
    const hasError = computed(() => error.value !== null);
    const hasResponse = computed(() => response.value.length > 0);

    let unsubscribeTask: (() => void) | null = null;
    let lastObservedModelSwitchCount = 0;

    /**
     * 把旧一页消息拼到列表前面。
     *
     * 去重按消息 id：任务快照重新发布时可能已包含同一 id，避免重复渲染。
     */
    function prependHistory(messages: SessionMessage[]): void {
        if (messages.length === 0) {
            return;
        }

        const existingIds = new Set(sessionHistory.value.map((message) => message.id));
        const appended = messages.filter((message) => !existingIds.has(message.id));
        if (appended.length === 0) {
            return;
        }

        sessionHistory.value = [...appended, ...sessionHistory.value];
    }

    /** 重置历史分页状态（切会话/清空时调用）。 */
    function resetHistoryPaging(): void {
        hasOlderHistory.value = false;
        oldestLoadedMessageId.value = null;
        isLoadingOlderHistory.value = false;
    }

    /** 记录首屏分页结果。 */
    function applyFirstHistoryPage(state: {
        hasMore: boolean;
        oldestMessageId: number | null;
    }): void {
        hasOlderHistory.value = state.hasMore;
        oldestLoadedMessageId.value = state.oldestMessageId;
    }

    /** 记录向前加载结果。 */
    function applyOlderHistoryPage(state: {
        hasMore: boolean;
        oldestMessageId: number | null;
    }): void {
        hasOlderHistory.value = state.hasMore;
        oldestLoadedMessageId.value = state.oldestMessageId ?? oldestLoadedMessageId.value;
    }

    let lastObservedTurnId: number | null = null;
    let lastDeliveredResponse = '';

    function clearObservedTaskState() {
        attachedTaskId.value = null;
        taskStatus.value = null;
        currentModel.value = null;
        pendingToolApproval.value = null;
        pendingApprovalQueue.value = [];
        pendingUserQuestion.value = null;
        lastObservedModelSwitchCount = 0;
        lastObservedTurnId = null;
        isLoading.value = false;
    }

    function clearTransientBuffers() {
        response.value = '';
        reasoning.value = '';
        error.value = null;
        lastDeliveredResponse = '';
    }

    /**
     * 将任务快照同步到页面状态。
     */
    function applyTaskSnapshot(snapshot: SessionTaskViewSnapshot) {
        attachedTaskId.value = snapshot.taskId;
        currentSessionId.value = snapshot.sessionId;
        sessionHistory.value = snapshot.sessionHistory;
        pendingToolApproval.value = snapshot.pendingToolApproval;
        pendingApprovalQueue.value = snapshot.pendingApprovals;
        pendingUserQuestion.value = snapshot.pendingUserQuestion;
        taskStatus.value = snapshot.status;
        currentModel.value = snapshot.currentModel;
        isLoading.value = snapshot.status === 'running' || snapshot.status === 'waiting_approval';
        error.value =
            snapshot.status === 'failed' && snapshot.error ? new Error(snapshot.error) : null;

        const buffers = extractLatestAssistantBuffers(snapshot.sessionHistory);
        response.value = buffers.response;
        reasoning.value = buffers.reasoning;

        // 更新会话内容
        // 对外仍保留“增量 chunk 回调”的体验，但内部真相源已经变成任务快照，所以这里用前后 diff 恢复增量。
        if (buffers.response.startsWith(lastDeliveredResponse)) {
            const appended = buffers.response.slice(lastDeliveredResponse.length);
            if (appended) {
                options.onChunk?.(appended);
            }
        }
        lastDeliveredResponse = buffers.response;

        // 更新模型选择
        if (
            snapshot.currentModel &&
            snapshot.modelSwitchCount > lastObservedModelSwitchCount &&
            snapshot.currentModel.providerId !== null
        ) {
            options.onModelSelected?.({
                modelId: snapshot.currentModel.modelId,
                providerId: snapshot.currentModel.providerId,
            });
        }

        if (
            snapshot.turnId !== null &&
            snapshot.sessionId !== null &&
            snapshot.turnId !== lastObservedTurnId
        ) {
            options.onTurnStarted?.({
                sessionId: snapshot.sessionId,
                turnId: snapshot.turnId,
            });
        }

        lastObservedModelSwitchCount = snapshot.modelSwitchCount;
        lastObservedTurnId = snapshot.turnId;
    }

    /**
     * 解除当前任务订阅并清空本地状态。
     */
    function detachTaskView(options: DetachTaskViewOptions = {}) {
        unsubscribeTask?.();
        unsubscribeTask = null;
        clearObservedTaskState();
        clearTransientBuffers();

        if (options.preserveSession) {
            return;
        }

        currentSessionId.value = null;
        sessionHistory.value = [];
    }

    /**
     * 挂接到指定任务并开始接收快照。
     */
    function attachTaskView(taskId: string, initialSnapshot?: SessionTaskViewSnapshot) {
        // 页面一次只观察一个任务；切换会话或重新挂载时，先断开旧订阅再挂到新任务。
        detachTaskView();

        if (initialSnapshot) {
            applyTaskSnapshot(initialSnapshot);
        }

        try {
            unsubscribeTask = sessionTaskCenter.subscribeTask(taskId, (snapshot) => {
                applyTaskSnapshot(snapshot);
            });
        } catch (rawError) {
            detachTaskView();
            error.value = rawError instanceof Error ? rawError : new Error(String(rawError));
        }
    }

    /**
     * 重置页面瞬时缓冲，但保留任务挂接关系。
     */
    function resetTaskViewState() {
        clearTransientBuffers();
    }

    onUnmounted(() => {
        detachTaskView();
    });

    return {
        isLoading,
        error,
        response,
        reasoning,
        hasError,
        hasResponse,
        currentSessionId,
        sessionHistory,
        attachedTaskId,
        taskStatus,
        currentModel,
        pendingToolApproval,
        pendingApprovalQueue,
        pendingUserQuestion,
        hasOlderHistory,
        oldestLoadedMessageId,
        isLoadingOlderHistory,
        prependHistory,
        resetHistoryPaging,
        applyFirstHistoryPage,
        applyOlderHistoryPage,
        attachTaskView,
        detachTaskView,
        resetTaskViewState,
    };
}
