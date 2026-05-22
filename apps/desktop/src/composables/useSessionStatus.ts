// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { onUnmounted, ref } from 'vue';

import { sessionTaskCenter } from '@/services/AgentService';
import type { SessionTaskStatus } from '@/services/AgentService/task/types';
import { eventService } from '@/services/EventService';
import { AppEvent } from '@/services/EventService/types';

function isActiveSessionStatus(
    status: SessionTaskStatus
): status is Extract<SessionTaskStatus, 'running' | 'waiting_approval'> {
    return status === 'running' || status === 'waiting_approval';
}

/**
 * 会话状态订阅 composable
 *
 * 通过事件总线订阅会话任务状态变更，提供响应式的会话状态查询接口
 */
export function useSessionStatus() {
    const sessionStatuses = ref<Map<number, SessionTaskStatus>>(new Map());
    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    function setSessionStatus(sessionId: number, status: SessionTaskStatus) {
        const nextStatuses = new Map(sessionStatuses.value);
        nextStatuses.set(sessionId, status);
        sessionStatuses.value = nextStatuses;
    }

    function clearSessionStatus(sessionId: number) {
        if (!sessionStatuses.value.has(sessionId)) {
            return;
        }

        const nextStatuses = new Map(sessionStatuses.value);
        nextStatuses.delete(sessionId);
        sessionStatuses.value = nextStatuses;
    }

    /**
     * 初始化时只回填仍由任务中心托管的活跃状态。
     * 终态改由数据库持久化后，这里不再负责 completed/failed/cancelled。
     */
    const refreshAllStatuses = (sessionIds: number[]) => {
        const newStatuses = new Map<number, SessionTaskStatus>();

        for (const sessionId of sessionIds) {
            const status = sessionTaskCenter.getSessionStatus(sessionId);
            if (status && isActiveSessionStatus(status.status)) {
                newStatuses.set(sessionId, status.status);
            }
        }

        sessionStatuses.value = newStatuses;
    };

    /**
     * 监听状态变更事件
     */
    void eventService
        .on(AppEvent.SESSION_TASK_STATUS_CHANGED, (event) => {
            if (isActiveSessionStatus(event.status)) {
                setSessionStatus(event.sessionId, event.status);
                return;
            }

            clearSessionStatus(event.sessionId);
        })
        .then((unlisten) => {
            if (disposed) {
                unlisten();
                return;
            }

            unsubscribe = unlisten;
        })
        .catch((error) => {
            console.error('[useSessionStatus] Failed to subscribe session status updates:', error);
        });

    onUnmounted(() => {
        disposed = true;
        unsubscribe?.();
        unsubscribe = null;
    });

    return {
        sessionStatuses,
        getSessionStatus: (sessionId: number) => sessionStatuses.value.get(sessionId),
        refreshAllStatuses,
    };
}
