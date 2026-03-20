/**
 * SearchView 请求层。
 * 收口请求提交、排队与会话续发逻辑，让输入层与页面层保持解耦。
 */
import {
    type ConversationMessage,
    type LoadedConversationSession,
    useAgent,
} from '@composables/useAgent';
import type { SessionEntity } from '@database/types';
import { type Index, isAttachmentSupported } from '@services/AiService/attachments';
import { listSessions } from '@services/AiService/session';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { type Ref, ref } from 'vue';

import type { PendingRequest, SearchModelOverride } from '../types';

interface UseSearchRequestFlowOptions {
    modelOverride: Ref<SearchModelOverride>;
    clearDraft: (options?: { preserveModelTag?: boolean }) => void;
    getSupportedAttachments: () => Index[];
    getUnsupportedAttachmentMessage: () => string | null;
}

const SESSION_LIST_LIMIT = 40;

/**
 * 搜索页请求流。
 * 负责 AI 请求排队、提交校验、历史会话切换和会话目录操作。
 *
 * @param options 页面状态与请求前置依赖。
 * @returns 请求流状态与页面事件处理函数。
 */
export function useSearchRequestFlow(options: UseSearchRequestFlowOptions) {
    const { modelOverride, clearDraft, getSupportedAttachments, getUnsupportedAttachmentMessage } =
        options;

    const pendingRequest = ref<PendingRequest | null>(null);
    const isWaitingForCompletion = ref(false);
    const sessionHistoryPopupOpen = ref(false);
    const sessionList = ref<SessionEntity[]>([]);
    const sessionListQuery = ref('');
    const isSessionListLoading = ref(false);
    let sessionListRequestId = 0;
    let sessionListLoadPromise: Promise<void> | null = null;
    let sessionListInFlightKey: string | null = null;
    let sessionListResolvedKey: string | null = null;

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
        conversationHistory,
        sendRequest,
        cancel,
        clearConversation,
        openSession: openStoredSession,
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
                modelId,
                providerId,
            } = pendingRequest.value;
            clearPendingRequestState();

            clearDraft({ preserveModelTag: true });

            await sendRequest(query, pendingAttachments, modelId, providerId);
        },
        onError: () => {
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
            clearPendingRequestState();
        },
    });

    function clearConversationState() {
        clearPendingRequestState();
        clearConversation();
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

        // 关闭弹窗时，旧筛选条件对应的请求即使稍后返回也不能再覆盖默认列表。
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

    async function handleSubmit(query: string) {
        const unsupportedAttachmentMessage = getUnsupportedAttachmentMessage();
        if (unsupportedAttachmentMessage) {
            sendNotification({ title: 'TouchAI', body: unsupportedAttachmentMessage });
            return;
        }

        if (isLoading.value) {
            if (pendingRequest.value) {
                return;
            }

            const selectedModelId = modelOverride.value.modelId;
            const selectedProviderId = modelOverride.value.providerId;
            pendingRequest.value = {
                query,
                attachments: getSupportedAttachments(),
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
            selectedModelId ?? undefined,
            selectedProviderId ?? undefined
        );
    }

    function clearAll() {
        clearConversationState();
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
        clearConversationState();
        clearDraft({ preserveModelTag: true });
    }

    async function openSession(sessionId: number): Promise<LoadedConversationSession> {
        clearDraft({ preserveModelTag: true });

        const loadedSession = await openStoredSession(sessionId);
        modelOverride.value = {
            modelId: loadedSession.modelId,
            providerId: loadedSession.providerId,
        };

        return loadedSession;
    }

    async function handleRegenerateMessage(messageId: string) {
        const messageIndex = conversationHistory.value.findIndex(
            (message) => message.id === messageId
        );
        if (messageIndex <= 0) {
            return;
        }

        const userMessage = conversationHistory.value[messageIndex - 1];
        if (!userMessage || userMessage.role !== 'user') {
            return;
        }

        const selectedModelId = modelOverride.value.modelId;
        const selectedProviderId = modelOverride.value.providerId;
        const supportedAttachments = (userMessage.attachments || []).filter(isAttachmentSupported);

        await sendRequest(
            userMessage.content,
            supportedAttachments,
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
        conversationHistory: conversationHistory as Ref<ConversationMessage[]>,
        sessionHistoryPopupOpen,
        sessionList,
        sessionListQuery,
        isSessionListLoading,
        clearConversation: clearConversationState,
        setSessionHistoryPopupOpen,
        updateSessionSearchQuery,
        refreshSessionList,
        ensureSessionListLoaded,
        startNewSession,
        openSession,
        handleSubmit,
        clearAll,
        cancelRequest,
        handleRegenerateMessage,
    };
}
