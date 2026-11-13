/**
 * SearchView 请求层。
 * 收口请求提交、排队与会话续发逻辑，让输入层与页面层保持解耦。
 */
import { useAgent } from '@composables/agent';
import type { SessionEntity } from '@database/types';
import {
    beginSearchInteraction,
    finishSearchInteraction,
    type SearchInteraction,
    selectSearchResult,
    settleSearchInteraction,
    trackSearchFeatureExposed,
    trackSurfaceOpened,
} from '@services/AnalyticsService/productInteractions';
import { notify } from '@services/NotificationService';
import { log } from '@services/ObservabilityService';
import { useStateMachine } from 'reka-ui';
import { computed, onUnmounted, type Ref, ref } from 'vue';

import {
    type Index,
    isAttachmentSupported,
} from '@/services/AgentService/infrastructure/attachments';
import { dismissSessionTerminalStatus, listSessions } from '@/services/AgentService/session';
import { eventService } from '@/services/EventService';
import { AppEvent } from '@/services/EventService/types';
import {
    createInputHistorySnapshot,
    type InputHistorySnapshot,
    type LoadedSessionInfo,
    type SessionMessage,
} from '@/types/session';

import type { PendingRequest, SearchModelOverride, SubmitShortcutIntent } from '../types';

interface UseSearchRequestFlowOptions {
    modelOverride: Ref<SearchModelOverride>;
    clearDraft: (options?: { preserveModelTag?: boolean }) => void;
    getSupportedAttachments: () => Index[];
    getUnsupportedAttachmentMessage: () => string | null;
    getCurrentInputSnapshot: (query: string) => InputHistorySnapshot;
}

const SESSION_LIST_LIMIT = 40;
const SESSION_SEARCH_DEBOUNCE_MS = 150;

export interface HistorySelection {
    readonly interaction: Promise<SearchInteraction>;
    readonly resultCount: number;
}

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

    const sessionHistoryOverlayOpen = ref(false);
    const sessionList = ref<SessionEntity[]>([]);
    const sessionListQuery = ref('');
    const isSessionListLoading = ref(false);
    const lastClosedSessionId = ref<number | null>(null);
    let sessionListRequestId = 0;
    let sessionListLoadPromise: Promise<void> | null = null;
    let sessionListInFlightKey: string | null = null;
    let sessionListResolvedKey: string | null = null;
    let stopSessionStatusListener: (() => void) | null = null;
    const sessionStatusLifecycle = useStateMachine('pending', {
        pending: { ready: 'active', failed: 'failed', dispose: 'disposed' },
        active: { dispose: 'disposed' },
        failed: { dispose: 'disposed' },
        disposed: {},
    });
    let pendingSessionSearch: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null =
        null;

    function cancelScheduledSessionSearch() {
        if (!pendingSessionSearch) return;
        clearTimeout(pendingSessionSearch.timer);
        pendingSessionSearch.resolve();
        pendingSessionSearch = null;
    }

    function invalidateSessionListRequest() {
        sessionListRequestId += 1;
        sessionListInFlightKey = null;
        sessionListLoadPromise = null;
    }

    // One history-search interaction settles once per popup session, using the
    // stable result count rather than any intermediate query. Selecting a
    // conversation closes the popup before the session opens, so close keeps the
    // marked interaction alive until the selection path has emitted its event.
    let historyInteraction: Promise<SearchInteraction> | null = null;
    const historySelections = new Set<HistorySelection>();
    let historyResultCount = 0;

    function beginHistoryInteraction() {
        const previous = historyInteraction;
        // A pending selection may still be resolving while the popup reopened;
        // it owns its own interaction and must not be finished by this reopen.
        if (previous) {
            void previous
                .then((interaction) => finishSearchInteraction(interaction))
                .catch(() => {});
        }
        historyInteraction = beginSearchInteraction('history');
        // Prefetched/cached rows are already visible to the user, so the initial
        // count must reflect the real displayed list rather than zero.
        historyResultCount = sessionList.value.length;
    }

    /**
     * Marks the interaction that the current history-popup open is selecting
     * from. Storing the promise itself prevents a reopened popup from attaching
     * the selection to a newer interaction.
     */
    function markHistorySelectionPending(): HistorySelection | null {
        if (!historyInteraction) {
            return null;
        }
        const selection = {
            interaction: historyInteraction,
            resultCount: historyResultCount,
        };
        historyInteraction = null;
        historySelections.add(selection);
        return selection;
    }

    function settleHistoryInteraction() {
        const ready = historyInteraction;
        if (!ready) {
            return;
        }
        historyInteraction = null;
        const resultCount = historyResultCount;
        void ready
            .then(async (interaction) => {
                await settleSearchInteraction(interaction, {
                    hasResults: resultCount > 0,
                    resultCount,
                });
                await finishSearchInteraction(interaction);
            })
            .catch(() => {});
    }

    function abandonHistorySelection(selection: HistorySelection | null) {
        reportHistorySelection(selection);
    }

    function reportHistorySelection(selection: HistorySelection | null, opened?: boolean) {
        if (!selection || !historySelections.delete(selection)) {
            return;
        }
        const { interaction: ready, resultCount } = selection;
        void ready
            .then(async (interaction) => {
                await settleSearchInteraction(interaction, {
                    hasResults: resultCount > 0,
                    resultCount,
                });
                if (opened !== undefined) {
                    await selectSearchResult(interaction, { category: 'conversation', opened });
                }
                await finishSearchInteraction(interaction);
            })
            .catch(() => {});
    }

    /**
     * Emits the history surface/feature exposure only after the native popup has
     * really opened. A failed open settles/releases without either event.
     */
    function reportHistoryInteractionOpened() {
        const ready = historyInteraction;
        if (!ready) {
            return;
        }
        void trackSurfaceOpened('history');
        void ready
            .then((interaction) => trackSearchFeatureExposed(interaction, 'history'))
            .catch(() => {});
    }

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

        if (!options?.refreshIfOpen || !sessionHistoryOverlayOpen.value) {
            return;
        }

        void refreshSessionList().catch((error) => {
            log.error(
                '[SearchView] Failed to refresh session history after cache invalidation:',
                error
            );
        });
    }

    const {
        isLoading,
        error,
        currentSessionId,
        sessionHistory,
        pendingUserMessages,
        sendRequest,
        cancel,
        clearSession,
        openSession: openStoredSession,
        pendingToolApproval,
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
    } = useAgent({
        onComplete: async () => {
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
        },
        onError: () => {
            // 失败的任务不会再投递 pending 消息，清掉避免气泡永远停在待发态。
            clearPendingUserMessages();
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
        },
        onModelSelected: ({ modelId, providerId }) => {
            modelOverride.value = {
                modelId,
                providerId,
            };
            updatePendingUserMessagesModel(modelId, providerId);
        },
        onTurnStarted: () => {
            // 只有 turn 真正落库后，sessions.last_message_at / updated_at 才会刷新。
            // 在这一拍作废缓存，历史列表才能立刻按最新时间重排，而不是等整轮结束。
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
        },
    });

    const pendingRequest = computed<PendingRequest | null>(() => {
        const message = pendingUserMessages.value[0];
        if (!message) {
            return null;
        }
        return {
            query: message.prompt,
            attachments: message.attachments,
            inputSnapshot: message.inputSnapshot,
            modelId: message.modelId,
            providerId: message.providerId,
        };
    });
    void eventService
        .on(AppEvent.SESSION_TASK_STATUS_CHANGED, (event) => {
            if (sessionStatusLifecycle.state.value === 'disposed') return;
            if (event.status !== 'completed' && event.status !== 'failed') {
                return;
            }

            if (event.sessionId === currentSessionId.value) {
                void dismissSessionTerminalStatus(event.sessionId).catch((error) => {
                    log.error(
                        '[SearchView] Failed to dismiss active session terminal status:',
                        error
                    );
                });
            }

            // 会话运行允许脱离当前页面继续进行；
            // 旧会话进入终态时，当前页不一定还能收到 useAgent 的 onComplete/onError。
            // 这里统一按全局状态事件作废历史列表缓存，保证 overlay 能看到最新终态圆点。
            invalidateSessionListCache({
                refreshIfOpen: true,
            });
        })
        .then((unlisten) => {
            if (sessionStatusLifecycle.state.value === 'disposed') {
                unlisten();
                return;
            }

            stopSessionStatusListener = unlisten;
            sessionStatusLifecycle.dispatch('ready');
        })
        .catch((error) => {
            sessionStatusLifecycle.dispatch('failed');
            log.error('[SearchView] Failed to subscribe session status events:', error);
        });

    onUnmounted(() => {
        cancelScheduledSessionSearch();
        invalidateSessionListRequest();
        sessionStatusLifecycle.dispatch('dispose');
        stopSessionStatusListener?.();
        stopSessionStatusListener = null;
        const ready = historyInteraction;
        historyInteraction = null;
        for (const selection of historySelections) {
            void selection.interaction
                .then((interaction) => finishSearchInteraction(interaction))
                .catch(() => {});
        }
        historySelections.clear();
        if (ready) {
            void ready.then((interaction) => finishSearchInteraction(interaction)).catch(() => {});
        }
    });

    function clearSessionState() {
        if (currentSessionId.value !== null) {
            lastClosedSessionId.value = currentSessionId.value;
        }
        clearSession();
    }

    /**
     * 历史会话 overlay 会在搜索和会话切换后反复刷新。
     * 这里用递增 requestId 丢弃过时响应，避免快速输入时列表回跳。
     */
    async function refreshSessionList() {
        cancelScheduledSessionSearch();
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
                historyResultCount = sessions.length;
                sessionListResolvedKey = requestKey;
            } catch (loadError) {
                log.error('[SearchView] Failed to load session history:', loadError);
                if (requestId === sessionListRequestId) {
                    sessionList.value = [];
                    historyResultCount = 0;
                    sessionListResolvedKey = null;
                }
            } finally {
                if (requestId === sessionListRequestId) {
                    isSessionListLoading.value = false;
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
    async function setSessionHistoryOverlayOpen(open: boolean) {
        sessionHistoryOverlayOpen.value = open;
        if (open) {
            return;
        }

        settleHistoryInteraction();
        cancelScheduledSessionSearch();
        const canReuseDefaultList = sessionListResolvedKey === buildDefaultSessionListRequestKey();

        // 关闭弹窗后要立刻作废当前筛选条件对应的请求，避免迟到响应覆盖默认列表。
        invalidateSessionListRequest();
        isSessionListLoading.value = false;
        sessionListQuery.value = '';

        if (canReuseDefaultList) {
            return;
        }

        sessionList.value = [];
        sessionListResolvedKey = null;
    }

    async function updateSessionSearchQuery(query: string) {
        cancelScheduledSessionSearch();
        // Invalidate on input, before the debounce, so an older response cannot publish meanwhile.
        invalidateSessionListRequest();
        sessionListQuery.value = query;
        isSessionListLoading.value = sessionHistoryOverlayOpen.value;
        if (!sessionHistoryOverlayOpen.value) return;

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingSessionSearch = null;
                void refreshSessionList().then(resolve, reject);
            }, SESSION_SEARCH_DEBOUNCE_MS);
            pendingSessionSearch = { timer, resolve };
        });
    }

    async function handleSubmit(
        query: string,
        inputSnapshotOverride?: InputHistorySnapshot,
        shortcutIntent: SubmitShortcutIntent = 'enter'
    ) {
        const unsupportedAttachmentMessage = getUnsupportedAttachmentMessage();
        if (unsupportedAttachmentMessage) {
            notify({ title: 'TouchAI', body: unsupportedAttachmentMessage });
            return;
        }

        const inputSnapshot = inputSnapshotOverride ?? getCurrentInputSnapshot(query);

        // 上一轮刚结束、下一条排队任务尚未挂载时，待发列表仍非空；
        // 这段衔接期也必须继续排队，否则会误发起一个与自动续发冲突的新任务。
        if (isLoading.value || pendingUserMessages.value.length > 0) {
            const selectedModelId = modelOverride.value.modelId;
            const selectedProviderId = modelOverride.value.providerId;
            const pendingMessage = enqueueUserMessage(
                {
                    prompt: query,
                    attachments: getSupportedAttachments(),
                    inputSnapshot,
                    modelId: selectedModelId ?? undefined,
                    providerId: selectedProviderId ?? undefined,
                },
                shortcutIntent === 'enter-modified' ? 'priority' : 'queue'
            );
            if (pendingMessage) {
                clearDraft({ preserveModelTag: true });
            }
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

    function cancelPendingRequest(): boolean {
        return clearPendingUserMessages();
    }

    function cancelLatestPendingMessage(): boolean {
        const latest = pendingUserMessages.value[pendingUserMessages.value.length - 1];
        return latest ? removePendingUserMessage(latest.id) : false;
    }

    function cancelRequest() {
        clearPendingUserMessages();
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

    function clearAll() {
        clearSessionState();
        clearDraft();
    }

    function clearLastClosedSessionId() {
        lastClosedSessionId.value = null;
    }

    function isSessionNotFoundError(error: unknown, sessionId: number): boolean {
        return error instanceof Error && error.message === `Session ${sessionId} not found`;
    }

    async function reopenLastClosedSession(): Promise<LoadedSessionInfo | null> {
        const sessionId = lastClosedSessionId.value;
        if (sessionId === null || sessionId === currentSessionId.value) {
            return null;
        }

        try {
            const loadedSession = await openSession(sessionId);
            if (currentSessionId.value === sessionId) {
                clearLastClosedSessionId();
            }
            return loadedSession;
        } catch (error) {
            if (isSessionNotFoundError(error, sessionId)) {
                clearLastClosedSessionId();
            }
            throw error;
        }
    }

    async function openSession(
        sessionId: number,
        origin: 'history' | 'other' = 'other',
        selection: HistorySelection | null = null
    ): Promise<LoadedSessionInfo> {
        if (sessionId === currentSessionId.value) {
            // The clicked conversation is already open; only a history-popup
            // selection is attributed to the pending interaction.
            if (origin === 'history') {
                reportHistorySelection(selection, true);
            }
            return {
                sessionId,
                title: '',
                modelId: modelOverride.value.modelId,
                providerId: modelOverride.value.providerId,
            };
        }

        let loadedSession: LoadedSessionInfo;
        try {
            loadedSession = await openStoredSession(sessionId);
        } catch (error) {
            if (origin === 'history') {
                reportHistorySelection(selection, false);
            }
            throw error;
        }
        clearDraft({ preserveModelTag: true });
        modelOverride.value = {
            modelId: loadedSession.modelId,
            providerId: loadedSession.providerId,
        };

        try {
            await dismissSessionTerminalStatus(sessionId);
            invalidateSessionListCache();
        } catch (error) {
            log.error('[SearchView] Failed to dismiss session terminal status:', error);
        }

        if (origin === 'history') {
            reportHistorySelection(selection, true);
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
            skills: userMessage.inputSnapshot?.skills ?? [],
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
        pendingUserMessages,
        isLoading,
        error,
        currentSessionId,
        sessionHistory: sessionHistory as Ref<SessionMessage[]>,
        sessionHistoryOverlayOpen,
        sessionList,
        sessionListQuery,
        isSessionListLoading,
        clearSession: clearSessionState,
        setSessionHistoryOverlayOpen,
        beginHistoryInteraction,
        markHistorySelectionPending,
        abandonHistorySelection,
        reportHistoryInteractionOpened,
        updateSessionSearchQuery,
        refreshSessionList,
        ensureSessionListLoaded,
        startNewSession,
        clearAll,
        reopenLastClosedSession,
        openSession,
        pendingToolApproval,
        pendingUserQuestion,
        approvePendingToolApproval,
        rejectPendingToolApproval,
        settleUserQuestion,
        handleSubmit,
        cancelRequest,
        cancelPendingRequest,
        cancelLatestPendingMessage,
        promotePendingUserMessage,
        removePendingUserMessage,
        updatePendingUserMessage,
        reorderPendingUserMessages,
        handleRegenerateMessage,
    };
}
