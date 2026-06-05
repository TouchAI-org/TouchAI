/**
 * SearchView 请求层。
 * 收口请求提交、排队与会话续发逻辑，让输入层与页面层保持解耦。
 */
import { useAgent } from '@composables/agent';
import type { SessionEntity } from '@database/types';
import { notify } from '@services/NotificationService';
import { onUnmounted, type Ref, ref } from 'vue';

import {
    type Index,
    isAttachmentSupported,
} from '@/services/AgentService/infrastructure/attachments';
import { dismissSessionTerminalStatus, listSessions } from '@/services/AgentService/session';
import { eventService } from '@/services/EventService';
import { AppEvent } from '@/services/EventService/types';
import { useSettingsStore } from '@/stores/settings';
import {
    createInputHistorySnapshot,
    type InputHistorySnapshot,
    type LoadedSessionInfo,
    type SessionMessage,
} from '@/types/session';

import type { PendingRequest, SearchModelOverride } from '../types';

interface UseSearchRequestFlowOptions {
    modelOverride: Ref<SearchModelOverride>;
    clearDraft: (options?: { preserveModelTag?: boolean }) => void;
    getSupportedAttachments: () => Index[];
    getUnsupportedAttachmentMessage: () => string | null;
    getCurrentInputSnapshot: (query: string) => InputHistorySnapshot;
}

const SESSION_LIST_LIMIT = 40;

/**
 * regenerate 需要能从“正常回复”或“尾随错误项”回溯到对应用户消息，
 * 因此不能再假设上一条一定是 user。
 */
function findNearestPrecedingUserMessage(
    history: SessionMessage[],
    startIndex: number
): SessionMessage | null {
    for (let index = startIndex - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role === 'user') {
            return message;
        }
    }

    return null;
}

/**
 * 搜索页请求流。
 * 负责 AI 请求排队、提交校验、历史会话切换和会话目录操作。
 *
 * @param options 页面状态与请求前置依赖。
 * @returns 请求流状态与页面事件处理函数。
 */
export function useSearchRequestFlow(options: UseSearchRequestFlowOptions) {
    const {
        modelOverride,
        clearDraft,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
        getCurrentInputSnapshot,
    } = options;

    const pendingRequest = ref<PendingRequest | null>(null);
    const isWaitingForCompletion = ref(false);
    const sessionHistoryPopupOpen = ref(false);
    const sessionList = ref<SessionEntity[]>([]);
    const sessionListQuery = ref('');
    const isSessionListLoading = ref(false);
    const settingsStore = useSettingsStore();
    let sessionListRequestId = 0;
    let sessionListLoadPromise: Promise<void> | null = null;
    let sessionListInFlightKey: string | null = null;
    let sessionListResolvedKey: string | null = null;
    let stopSessionStatusListener: (() => void) | null = null;
    let sessionStatusListenerDisposed = false;

    function buildSessionListRequestKey(): string {
        return JSON.stringify({
            query: sessionListQuery.value.trim(),
            limit: SESSION_LIST_LIMIT,
        });
    }

    function buildDefaultSessionListRequestKey(): string {
        return JSON.stringify({
            query: '',
            limit: SESSION_LIST_LIMIT,
        });
    }

    /**
     * 历史列表的真相源在数据库里，但 hover 预取和弹窗打开可能几乎同时触发。
     * 这里按“筛选条件键”去重，避免同一组条件连发两次查询。
     */
    function invalidateSessionListCache(options?: { refreshIfOpen?: boolean }) {
        sessionListResolvedKey = null;

        if (!options?.refreshIfOpen || !sessionHistoryPopupOpen.value) {
            return;
        }

        void refreshSessionList().catch((error) => {
            console.error(
                '[SearchView] Failed to refresh session history after cache invalidation:',
                error
            );
        });
    }

    /**
     * 排队请求只是一层 UI 状态，不应跨失败、取消或会话切换残留。
     * 一旦残留，工具栏会一直走 disabled 分支，表现为三个按钮 hover/click 全失效。
     */
    function clearPendingRequestState() {
        pendingRequest.value = null;
        isWaitingForCompletion.value = false;
    }

    const {
        isLoading,
        error,
        currentSessionId,
        sessionHistory,
        sendRequest,
        cancel,
        clearSession,
        openSession: openStoredSession,
        pendingToolApproval,
        pendingUserQuestion,
        approvePendingToolApproval,
        rejectPendingToolApproval,
        settleUserQuestion,
    } = useAgent({
        onComplete: async () => {
            invalidateSessionListCache({
                refreshIfOpen: true,
            });

            if (!pendingRequest.value) {
                return;
            }

            const {
                query,
                attachments: pendingAttachments,
                inputSnapshot,
                modelId,
                providerId,
            } = pendingRequest.value;
            clearPendingRequestState();

            clearDraft({ preserveModelTag: true });

            await sendRequest(query, pendingAttachments, inputSnapshot, modelId, providerId);
        },
        onError: () => {
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
            clearPendingRequestState();
        },
        onModelSelected: ({ modelId, providerId }) => {
            modelOverride.value = {
                modelId,
                providerId,
            };

            if (pendingRequest.value) {
                pendingRequest.value = {
                    ...pendingRequest.value,
                    modelId,
                    providerId,
                };
            }
        },
        onTurnStarted: () => {
            // 只有 turn 真正落库后，sessions.last_message_at / updated_at 才会刷新。
            // 在这一拍作废缓存，历史列表才能立刻按最新时间重排，而不是等整轮结束。
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
        },
    });

    void eventService
        .on(AppEvent.SESSION_TASK_STATUS_CHANGED, (event) => {
            if (event.status !== 'completed' && event.status !== 'failed') {
                return;
            }

            if (event.sessionId === currentSessionId.value) {
                void dismissSessionTerminalStatus(event.sessionId).catch((error) => {
                    console.error(
                        '[SearchView] Failed to dismiss active session terminal status:',
                        error
                    );
                });
            }

            // 会话运行允许脱离当前页面继续进行；
            // 旧会话进入终态时，当前页不一定还能收到 useAgent 的 onComplete/onError。
            // 这里统一按全局状态事件作废历史列表缓存，保证 popup 能看到最新终态圆点。
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
        })
        .then((unlisten) => {
            if (sessionStatusListenerDisposed) {
                unlisten();
                return;
            }

            stopSessionStatusListener = unlisten;
        })
        .catch((error) => {
            console.error('[SearchView] Failed to subscribe session status events:', error);
        });

    onUnmounted(() => {
        sessionStatusListenerDisposed = true;
        stopSessionStatusListener?.();
        stopSessionStatusListener = null;
    });

    function clearSessionState() {
        if (currentSessionId.value !== null) {
            void settingsStore.updateLastClosedSessionId(currentSessionId.value).catch((error) => {
                console.error('[SearchView] Failed to persist last closed session id:', error);
            });
        }
        clearPendingRequestState();
        clearSession();
    }

    /**
     * 历史会话 popup 会在搜索和会话切换后反复刷新。
     * 这里用递增 requestId 丢弃过时响应，避免快速输入时列表回跳。
     */
    async function refreshSessionList() {
        const requestKey = buildSessionListRequestKey();
        if (sessionListLoadPromise && sessionListInFlightKey === requestKey) {
            return sessionListLoadPromise;
        }

        const requestId = ++sessionListRequestId;
        isSessionListLoading.value = true;
        sessionListInFlightKey = requestKey;

        sessionListLoadPromise = (async () => {
            try {
                const sessions = await listSessions({
                    query: sessionListQuery.value,
                    limit: SESSION_LIST_LIMIT,
                });

                if (requestId !== sessionListRequestId) {
                    return;
                }

                sessionList.value = sessions;
                sessionListResolvedKey = requestKey;
            } catch (loadError) {
                console.error('[SearchView] Failed to load session history:', loadError);
                if (requestId === sessionListRequestId) {
                    sessionList.value = [];
                    sessionListResolvedKey = null;
                }
            } finally {
                if (requestId === sessionListRequestId) {
                    isSessionListLoading.value = false;
                }

                if (sessionListInFlightKey === requestKey) {
                    sessionListInFlightKey = null;
                    sessionListLoadPromise = null;
                }
            }
        })();

        return sessionListLoadPromise;
    }

    /**
     * 仅在当前筛选条件还没有结果、且也没有同键请求进行中时才真正查询。
     *
     * 打开历史弹窗时走这个方法，可以让“hover 预取”和“直接打开兜底”共享同一套去重逻辑。
     */
    async function ensureSessionListLoaded() {
        if (sessionListResolvedKey === buildSessionListRequestKey()) {
            return;
        }

        await refreshSessionList();
    }

    /**
     * 仅维护历史会话弹层开关与搜索词重置。
     * 打开后的列表刷新由页面层决定，这样弹层可以先渲染再异步加载数据。
     *
     * @param open 是否打开历史会话弹层。
     */
    async function setSessionHistoryPopupOpen(open: boolean) {
        sessionHistoryPopupOpen.value = open;
        if (open) {
            return;
        }

        const canReuseDefaultList = sessionListResolvedKey === buildDefaultSessionListRequestKey();

        // 关闭弹窗后要立刻作废当前筛选条件对应的请求，避免迟到响应覆盖默认列表。
        sessionListRequestId += 1;
        sessionListInFlightKey = null;
        sessionListLoadPromise = null;
        isSessionListLoading.value = false;
        sessionListQuery.value = '';

        if (canReuseDefaultList) {
            return;
        }

        sessionList.value = [];
        sessionListResolvedKey = null;
    }

    async function updateSessionSearchQuery(query: string) {
        sessionListQuery.value = query;
        if (sessionHistoryPopupOpen.value) {
            await refreshSessionList();
        }
    }

    async function handleSubmit(query: string, inputSnapshotOverride?: InputHistorySnapshot) {
        const unsupportedAttachmentMessage = getUnsupportedAttachmentMessage();
        if (unsupportedAttachmentMessage) {
            notify({ title: 'TouchAI', body: unsupportedAttachmentMessage });
            return;
        }

        const inputSnapshot = inputSnapshotOverride ?? getCurrentInputSnapshot(query);

        if (isLoading.value) {
            if (pendingRequest.value) {
                return;
            }

            const selectedModelId = modelOverride.value.modelId;
            const selectedProviderId = modelOverride.value.providerId;
            pendingRequest.value = {
                query,
                attachments: getSupportedAttachments(),
                inputSnapshot,
                modelId: selectedModelId ?? undefined,
                providerId: selectedProviderId ?? undefined,
            };
            isWaitingForCompletion.value = true;
            return;
        }

        const selectedModelId = modelOverride.value.modelId;
        const selectedProviderId = modelOverride.value.providerId;
        const supportedAttachments = getSupportedAttachments();

        clearDraft({ preserveModelTag: true });

        await sendRequest(
            query,
            supportedAttachments,
            inputSnapshot,
            selectedModelId ?? undefined,
            selectedProviderId ?? undefined
        );
    }

    function clearAll() {
        clearSessionState();
        clearDraft();
    }

    function cancelRequest() {
        clearPendingRequestState();
        if (isLoading.value) {
            cancel();
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
        }
    }

    function startNewSession() {
        clearSessionState();
        clearDraft();
    }

    async function reopenLastClosedSession(): Promise<LoadedSessionInfo | null> {
        const sessionId = settingsStore.lastClosedSessionId;
        if (sessionId === null) {
            return null;
        }

        const loadedSession = await openSession(sessionId);
        if (currentSessionId.value === sessionId) {
            await settingsStore.updateLastClosedSessionId(null);
        }
        return loadedSession;
    }

    async function openSession(sessionId: number): Promise<LoadedSessionInfo> {
        // 切换会话时必须丢弃当前页面暂存的排队请求，
        // 否则新会话会错误继承旧会话的“等待发送”锁态。
        clearPendingRequestState();
        clearDraft({ preserveModelTag: true });

        const loadedSession = await openStoredSession(sessionId);
        modelOverride.value = {
            modelId: loadedSession.modelId,
            providerId: loadedSession.providerId,
        };

        try {
            await dismissSessionTerminalStatus(sessionId);
            invalidateSessionListCache();
        } catch (error) {
            console.error('[SearchView] Failed to dismiss session terminal status:', error);
        }

        return loadedSession;
    }

    async function handleRegenerateMessage(messageId: string) {
        const messageIndex = sessionHistory.value.findIndex((message) => message.id === messageId);
        if (messageIndex <= 0) {
            return;
        }

        const userMessage = findNearestPrecedingUserMessage(sessionHistory.value, messageIndex);
        if (!userMessage) {
            return;
        }

        const selectedModelId = modelOverride.value.modelId;
        const selectedProviderId = modelOverride.value.providerId;
        const supportedAttachments = (userMessage.attachments || []).filter(isAttachmentSupported);
        const inputSnapshot = createInputHistorySnapshot({
            text: userMessage.inputSnapshot?.text ?? userMessage.content,
            attachments: userMessage.inputSnapshot?.attachments ?? userMessage.attachments ?? [],
            editorDoc: userMessage.inputSnapshot?.editorDoc,
            excludeFromHistory: true,
        });

        await sendRequest(
            inputSnapshot.text,
            supportedAttachments,
            inputSnapshot,
            selectedModelId ?? undefined,
            selectedProviderId ?? undefined
        );
    }

    return {
        pendingRequest,
        isWaitingForCompletion,
        isLoading,
        error,
        currentSessionId,
        sessionHistory: sessionHistory as Ref<SessionMessage[]>,
        sessionHistoryPopupOpen,
        sessionList,
        sessionListQuery,
        isSessionListLoading,
        clearSession: clearSessionState,
        setSessionHistoryPopupOpen,
        updateSessionSearchQuery,
        refreshSessionList,
        ensureSessionListLoaded,
        startNewSession,
        reopenLastClosedSession,
        openSession,
        pendingToolApproval,
        pendingUserQuestion,
        approvePendingToolApproval,
        rejectPendingToolApproval,
        settleUserQuestion,
        handleSubmit,
        clearAll,
        cancelRequest,
        handleRegenerateMessage,
    };
}
