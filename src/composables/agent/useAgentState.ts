// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { computed, onUnmounted, ref } from 'vue';

import { sessionTaskCenter, type SessionTaskSnapshot } from '@/services/AgentService';
import type { SessionMessage } from '@/types/session';

export interface UseAgentStateOptions {
    onChunk?: (content: string) => void;
    onModelSelected?: (target: { modelId: string; providerId: number }) => void;
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
    const taskStatus = ref<SessionTaskSnapshot['status'] | null>(null);
    const currentModel = ref<SessionTaskSnapshot['currentModel']>(null);
    const pendingToolApproval = ref<SessionTaskSnapshot['pendingToolApproval']>(null);
    const pendingApprovalQueue = ref<SessionTaskSnapshot['pendingApprovals']>([]);
    const hasError = computed(() => error.value !== null);
    const hasResponse = computed(() => response.value.length > 0);

    let unsubscribeTask: (() => void) | null = null;
    let lastObservedModelSwitchCount = 0;
    let lastDeliveredResponse = '';

    /**
     * 将任务快照同步到页面状态。
     */
    function applyTaskSnapshot(snapshot: SessionTaskSnapshot) {
        attachedTaskId.value = snapshot.taskId;
        currentSessionId.value = snapshot.sessionId;
        sessionHistory.value = snapshot.sessionHistory;
        pendingToolApproval.value = snapshot.pendingToolApproval;
        pendingApprovalQueue.value = snapshot.pendingApprovals;
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

        lastObservedModelSwitchCount = snapshot.modelSwitchCount;
    }

    /**
     * 解除当前任务订阅并清空本地状态。
     */
    function detachTaskView() {
        unsubscribeTask?.();
        unsubscribeTask = null;
        attachedTaskId.value = null;
        currentSessionId.value = null;
        sessionHistory.value = [];
        taskStatus.value = null;
        currentModel.value = null;
        pendingToolApproval.value = null;
        pendingApprovalQueue.value = [];
        response.value = '';
        reasoning.value = '';
        error.value = null;
        lastObservedModelSwitchCount = 0;
        lastDeliveredResponse = '';
        isLoading.value = false;
    }

    /**
     * 挂接到指定任务并开始接收快照。
     */
    function attachTaskView(taskId: string, initialSnapshot?: SessionTaskSnapshot) {
        // 页面一次只观察一个任务；切换会话或重新挂载时，先断开旧订阅再挂到新任务。
        detachTaskView();

        if (initialSnapshot) {
            lastObservedModelSwitchCount = initialSnapshot.modelSwitchCount;
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
        response.value = '';
        reasoning.value = '';
        error.value = null;
        lastDeliveredResponse = '';
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
        attachTaskView,
        detachTaskView,
        resetTaskViewState,
    };
}
