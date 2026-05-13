<script setup lang="ts">
    // Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

    import { useSessionStatus } from '@composables/useSessionStatus';
    import { notify } from '@services/NotificationService';
    import {
        popupManager as popupService,
        type SessionHistoryData,
        type SessionHistorySessionItem,
    } from '@services/PopupService';
    import { nextTick, onMounted, onUnmounted, reactive, ref, toRef, watch } from 'vue';

    import { mcpManager } from '@/services/AgentService/infrastructure/mcp';
    import type { SessionTaskStatus } from '@/services/AgentService/task/types';
    import { clipboardService } from '@/services/ClipboardService';
    import { useMcpStore } from '@/stores/mcp';
    import { useSettingsStore } from '@/stores/settings';

    import ConversationPanel from './components/ConversationPanel/index.vue';
    import QuickSearchPanel from './components/QuickSearchPanel/index.vue';
    import SearchBar from './components/SearchBar/index.vue';
    import {
        createPopupSurfaceCoordinator,
        createSearchEntryPolicy,
        createSearchInteractionContext,
        useQuickSearchCoordinator,
        useSearchOverlayMachine,
    } from './composables/searchInteraction';
    import { useSearchAttachments, useSearchDraftController } from './composables/useSearchInput';
    import {
        useSearchKeyboard,
        useSearchModelDropdownCoordinator,
        useSearchPageController,
        useSearchPageLifecycle,
        useSearchPanelFocusRestore,
        useSearchWindowPin,
    } from './composables/useSearchPage';
    import { useSearchRequestFlow } from './composables/useSearchRequest';
    import { useSessionHistoryPopup } from './composables/useSessionHistoryPopup';
    import type {
        ConversationPanelHandle,
        QuickSearchHandle,
        SearchBarHandle,
        SearchCursorContext,
        SearchDraftState,
        SearchModelDropdownState,
        SearchModelOverride,
    } from './types';
    import { canAutoPasteIntoDraft } from './utils/clipboardDraft';

    defineOptions({
        name: 'SearchViewPage',
    });

    const viewReady = ref(false);
    const searchBar = ref<SearchBarHandle>();
    const draft = reactive<SearchDraftState>({
        queryText: '',
        attachments: [],
        modelOverride: {
            modelId: null,
            providerId: null,
        },
    });
    const queryText = toRef(draft, 'queryText');
    const attachments = toRef(draft, 'attachments');
    const modelOverride = toRef(draft, 'modelOverride');
    const cursorContext = ref<SearchCursorContext>({
        isMultiLine: false,
        cursorAtStart: true,
    });
    const modelDropdownState = ref<SearchModelDropdownState>({
        isOpen: false,
    });
    const modelDropdownQuery = ref('');
    const quickSearchOpen = ref(false);
    const quickSearchPanel = ref<QuickSearchHandle>();
    const conversationPanel = ref<ConversationPanelHandle>();
    const historyAnchorElement = ref<HTMLElement | null>(null);
    const pageContainer = ref<HTMLElement | null>(null);
    const approvalAttentionToken = ref(0);
    const isDragging = ref(false);
    const mcpStore = useMcpStore();
    const settingsStore = useSettingsStore();
    const { sessionStatuses, refreshAllStatuses: refreshSessionStatuses } = useSessionStatus();
    const { isPinned, syncWindowPinState, setWindowPinned, toggleWindowPin } = useSearchWindowPin();
    const widgetBridgeWindow = window as Window & {
        sendPrompt?: (text: string) => void;
        openLink?: (url: string) => void;
    };
    const searchInteractionContext = createSearchInteractionContext();
    const searchEntryPolicy = createSearchEntryPolicy();
    const popupSurfaceCoordinator = createPopupSurfaceCoordinator(searchInteractionContext);

    /**
     * 判断交互上下文里的 popup 会话是否仍然对应 popupManager 当前会话。
     */
    function isLiveActivePopupSession() {
        const activeIdentity = searchInteractionContext.state.activePopupIdentity;
        return (
            popupService.state.isOpen === true &&
            activeIdentity !== null &&
            popupService.state.currentPopupId === activeIdentity.popupId &&
            popupService.state.currentWindowLabel === activeIdentity.windowLabel &&
            popupService.state.currentPopupSessionVersion === activeIdentity.popupSessionVersion
        );
    }

    const controller = useSearchPageController({
        searchBar,
        quickSearchOpen,
        quickSearchPanel,
        conversationPanel,
    });
    const { handleQuickSearchBlankClick } = useSearchPanelFocusRestore({
        controller,
    });

    const {
        handleModelChange,
        createAttachmentFromClipboardPath,
        removeAttachment,
        clearAttachments,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
    } = useSearchAttachments({
        attachments,
    });

    const { clearDraft, handlePaste, importClipboardPayload } = useSearchDraftController({
        queryText,
        attachments,
        modelOverride,
        clearAttachments,
        createAttachmentFromClipboardPath,
    });

    const {
        pendingRequest,
        isWaitingForCompletion,
        isLoading,
        error,
        currentSessionId,
        sessionHistory,
        sessionHistoryPopupOpen,
        sessionList,
        sessionListQuery,
        isSessionListLoading,
        clearSession,
        setSessionHistoryPopupOpen,
        updateSessionSearchQuery,
        refreshSessionList,
        ensureSessionListLoaded,
        startNewSession,
        openSession,
        pendingToolApproval,
        approvePendingToolApproval,
        rejectPendingToolApproval,
        handleSubmit,
        clearAll,
        cancelRequest,
        handleRegenerateMessage,
    } = useSearchRequestFlow({
        modelOverride,
        clearDraft,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
    });

    const { isQuickSearchOpen, shouldTriggerQuickSearch } = useQuickSearchCoordinator({
        queryText,
        attachments,
        sessionHistory,
        cursorContext,
        modelOverride,
        modelDropdownState,
        quickSearchOpen,
        controller,
    });

    const {
        requestModelDropdownOpen,
        handleQuickSearchClosedForModelDropdown,
        handleLayoutStableForModelDropdown,
        handleModelDropdownOpened,
        handleModelDropdownClosed,
        syncOverlayState,
    } = useSearchOverlayMachine({
        isQuickSearchOpen,
        modelDropdownState,
    });

    function isDisplayableSessionStatus(
        status: SessionTaskStatus | null | undefined
    ): status is SessionHistorySessionItem['displayStatus'] {
        return (
            status === 'running' ||
            status === 'waiting_approval' ||
            status === 'completed' ||
            status === 'failed'
        );
    }

    function resolveSessionDisplayStatus(
        sessionId: number,
        pendingTerminalStatus: SessionHistorySessionItem['pending_terminal_status']
    ): SessionHistorySessionItem['displayStatus'] {
        const runtimeStatus = sessionStatuses.value.get(sessionId) ?? null;
        if (isDisplayableSessionStatus(runtimeStatus)) {
            return runtimeStatus;
        }

        if (sessionId === currentSessionId.value) {
            return null;
        }

        return pendingTerminalStatus ?? null;
    }

    const {
        closeModelDropdown,
        hideAllDropdowns,
        refreshModelDropdownData,
        handleToggleModelDropdownRequest: handleToggleModelDropdownRequestBase,
    } = useSearchModelDropdownCoordinator({
        pageContainer,
        controller,
        modelOverride,
        modelDropdownState,
        modelDropdownQuery,
        requestModelDropdownOpen,
        handleQuickSearchClosedForModelDropdown,
        handleLayoutStableForModelDropdown,
        handleModelDropdownOpened,
        handleModelDropdownClosed,
        syncOverlayState,
        onPopupSessionStart: (identity) => {
            popupSurfaceCoordinator.activatePopup({
                ...identity,
                popupType: 'model-dropdown-surface',
            });
        },
        onPopupSessionEnd: () => {
            popupSurfaceCoordinator.clearActivePopup();
        },
    });

    async function handleAiModelsUpdated() {
        controller.invalidateModelDropdownData();
        await controller.loadActiveModel();

        if (!modelDropdownState.value.isOpen) {
            return;
        }

        await controller.prefetchModelDropdownData();
        await refreshModelDropdownData();
    }

    const { hideSearchWindow } = useSearchPageLifecycle({
        pageContainer,
        controller,
        viewReady,
        isDragging,
        isPinned,
        interactionContext: searchInteractionContext,
        syncWindowPinState,
        clearSession,
        reconcilePopupSurfaces: hideAllPopups,
        onSurfaceHidden: clearSurfaceUiAfterHidden,
        handleSearchSurfaceCommand: async (payload) => {
            if (payload.command === 'toggle-model-dropdown') {
                await handleToggleModelDropdownRequest();
            }
        },
        handleAiModelsUpdated,
        handleShortcutAutoPaste: tryShortcutAutoPaste,
    });

    function getSessionHistoryPopupData(): SessionHistoryData {
        return {
            sessions: sessionList.value.map<SessionHistorySessionItem>((session) => ({
                ...session,
                displayStatus: resolveSessionDisplayStatus(
                    session.id,
                    session.pending_terminal_status
                ),
            })),
            activeSessionId: currentSessionId.value,
            searchQuery: sessionListQuery.value,
            isLoading: isSessionListLoading.value,
        };
    }

    const sessionHistoryPopup = useSessionHistoryPopup({
        getAnchorElement: () =>
            historyAnchorElement.value ?? conversationPanel.value?.getHistoryAnchor() ?? null,
        getPopupData: getSessionHistoryPopupData,
        isSessionHistoryActive: () => sessionHistoryPopupOpen.value,
        onSessionOpen: handleOpenSession,
        onSessionSearchQueryChange: handleSessionSearchQueryChange,
        onClose: () => setSessionHistoryPopupOpen(false),
        onPopupSessionStart: (identity) => {
            popupSurfaceCoordinator.activatePopup({
                ...identity,
                popupType: 'session-history-surface',
            });
        },
        onPopupSessionEnd: () => {
            popupSurfaceCoordinator.clearActivePopup();
        },
    });

    useSearchKeyboard({
        viewReady,
        queryText,
        cursorContext,
        modelOverride,
        modelDropdownState,
        controller,
        sessionHistory,
        pendingRequest,
        isWaitingForCompletion,
        isLoading,
        pendingToolApproval,
        approvePendingToolApproval,
        rejectPendingToolApproval,
        promptPendingToolApprovalAttention,
        hasDraftContent: () => Boolean(queryText.value.trim()) || attachments.value.length > 0,
        getActivePopupType: () =>
            isLiveActivePopupSession() ? searchInteractionContext.state.activePopupType : null,
        hasActivePopupWindowFocus: () => isLiveActivePopupSession(),
        isQuickSearchOpen,
        shouldTriggerQuickSearch,
        sessionHistoryPopupOpen,
        hideAllPopups,
        hideSearchWindow,
        closeModelDropdown,
        toggleModelDropdown: handleToggleModelDropdownRequest,
        openHistoryDialog,
        startNewSession: handleStartNewSession,
        toggleWindowPin: handleToggleWindowPin,
        handleSubmit,
        clearDraft,
        clearAll,
        cancelRequest,
        clearSession,
    });

    function handleQueryTextChange(value: string) {
        queryText.value = value;
    }

    function handleCursorContextChange(context: SearchCursorContext) {
        cursorContext.value = context;
    }

    function handleModelOverrideChange(nextModelOverride: SearchModelOverride) {
        draft.modelOverride = nextModelOverride;
    }

    function handleAttachmentRemoveRequest(id: string) {
        removeAttachment(id);
    }

    function handleQuickSearchOpenChange(value: boolean) {
        quickSearchOpen.value = value;
    }

    async function handlePinChange(value: boolean) {
        try {
            await setWindowPinned(value);
        } catch (error) {
            console.error('[SearchView] Failed to update window pin state:', error);
            await notify({
                title: 'TouchAI - 置顶切换失败',
                body: '窗口置顶状态更新失败，请稍后重试',
            });
        }
    }

    function promptPendingToolApprovalAttention() {
        approvalAttentionToken.value += 1;
    }

    /**
     * 统一处理页面捕获到的粘贴事件。
     */
    function handlePagePaste(event: ClipboardEvent) {
        if (pendingToolApproval.value) {
            event.preventDefault();
            event.stopPropagation();
            promptPendingToolApprovalAttention();
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        void handlePaste();
    }

    /**
     * 在快捷键唤起窗口后尝试 auto-paste。
     */
    async function tryShortcutAutoPaste() {
        const visibilityEpoch = searchInteractionContext.state.visibilityEpoch;

        if (
            !searchEntryPolicy.shouldCheckShortcutEntry({
                activationSource: searchInteractionContext.state.activationSource,
                visibilityEpoch,
                entryCheckArmedVisibilityEpoch:
                    searchInteractionContext.state.entryCheckArmedVisibilityEpoch,
                lastEntryCheckedVisibilityEpoch:
                    searchInteractionContext.state.lastEntryCheckedVisibilityEpoch,
            })
        ) {
            return;
        }

        try {
            if (
                !canAutoPasteIntoDraft({
                    queryText: queryText.value,
                    attachmentCount: attachments.value.length,
                    sessionMessageCount: sessionHistory.value.length,
                    hasModelOverride: Boolean(modelOverride.value.modelId),
                })
            ) {
                return;
            }

            const payload = await clipboardService.consumeShortcutAutoPastePayload(3000);
            if (!payload) {
                return;
            }

            if (!searchEntryPolicy.shouldConsumeSnapshot(payload.snapshotId)) {
                return;
            }

            searchEntryPolicy.markSnapshotConsumed(payload.snapshotId);

            await importClipboardPayload(payload, { trimTextBoundary: true });
        } finally {
            searchInteractionContext.markEntryChecked(visibilityEpoch);
        }
    }

    async function closeSessionHistoryPopup() {
        try {
            await sessionHistoryPopup.close();
        } finally {
            await setSessionHistoryPopupOpen(false);
        }
    }

    async function hideAllPopups() {
        await closeSessionHistoryPopup();
        await hideAllDropdowns();
    }

    async function clearSurfaceUiAfterHidden() {
        await setSessionHistoryPopupOpen(false);
        modelDropdownState.value = {
            isOpen: false,
        };
        modelDropdownQuery.value = '';
        handleModelDropdownClosed();
    }

    async function handleToggleModelDropdownRequest() {
        await closeSessionHistoryPopup();
        await handleToggleModelDropdownRequestBase();
    }

    async function openHistoryDialog() {
        if (
            sessionHistoryPopupOpen.value ||
            (popupService.state.isOpen &&
                popupService.state.currentType === 'session-history-popup')
        ) {
            await closeSessionHistoryPopup();
            return;
        }

        // 根据是否有会话面板，选择不同的 anchor 元素
        const anchorElement =
            sessionHistory.value.length > 0
                ? (conversationPanel.value?.getHistoryAnchor() ?? null)
                : pageContainer.value;

        if (!anchorElement) {
            return;
        }

        await handleHistoryOpenChange({
            open: true,
            anchorElement,
        });
    }

    async function handleHistoryOpenChange(payload: {
        open: boolean;
        anchorElement: HTMLElement | null;
    }) {
        historyAnchorElement.value = payload.anchorElement;

        if (!payload.open) {
            await closeSessionHistoryPopup();
            return;
        }

        controller.closeQuickSearch();
        await hideAllDropdowns();
        await setSessionHistoryPopupOpen(true);
        try {
            await sessionHistoryPopup.open();

            void ensureSessionListLoaded().catch((error) => {
                console.error(
                    '[SearchView] Failed to ensure session history before popup interaction:',
                    error
                );
            });
        } catch (error) {
            await setSessionHistoryPopupOpen(false);
            console.error('[SearchView] Failed to open session history popup:', error);
        }
    }

    function handleHistoryPrefetch(anchorElement: HTMLElement | null) {
        historyAnchorElement.value = anchorElement;

        if (sessionHistoryPopupOpen.value) {
            return;
        }

        void ensureSessionListLoaded().catch((error) => {
            console.error('[SearchView] Failed to prefetch session history:', error);
        });
    }

    function handleModelDropdownPrefetch() {
        if (modelDropdownState.value.isOpen) {
            return;
        }

        void controller.prefetchModelDropdownData().catch((error) => {
            console.error('[SearchView] Failed to refresh model dropdown data on hover:', error);
        });
    }

    async function handleSessionSearchQueryChange(value: string) {
        await updateSessionSearchQuery(value);
    }

    async function handleStartNewSession() {
        if (sessionHistory.value.length === 0) {
            return;
        }

        controller.closeQuickSearch();
        await hideAllPopups();
        startNewSession();
        await controller.focusSearchInput();
    }

    async function handleToggleWindowPin() {
        try {
            await toggleWindowPin();
        } catch (error) {
            console.error('[SearchView] Failed to toggle window pin state:', error);
            await notify({
                title: 'TouchAI - 置顶切换失败',
                body: '窗口置顶状态更新失败，请稍后重试',
            });
        }
    }

    async function handleOpenSession(sessionId: number) {
        controller.closeQuickSearch();
        await hideAllPopups();

        try {
            await openSession(sessionId);
            await nextTick();
            conversationPanel.value?.revealLatestContent();
        } catch (error) {
            console.error('[SearchView] Failed to open session:', error);

            const isMissingSession =
                error instanceof Error && /not found|不存在/i.test(error.message);

            if (isMissingSession) {
                void refreshSessionList().catch((refreshError) => {
                    console.error(
                        '[SearchView] Failed to refresh session history after open failure:',
                        refreshError
                    );
                });
            }

            await notify({
                title: 'TouchAI - 打开会话失败',
                body: isMissingSession
                    ? '该会话不存在，历史列表已刷新'
                    : '打开会话失败，请稍后重试',
            });

            await controller.focusSearchInput();
        }
    }

    function handleWidgetSendPrompt(text: string) {
        const normalizedText = text.trim();
        if (!normalizedText) {
            return;
        }

        if (pendingToolApproval.value) {
            promptPendingToolApprovalAttention();
            return;
        }

        void handleSubmit(normalizedText);
    }

    function handleWidgetOpenLink(url: string) {
        const normalizedUrl = url.trim();
        if (!normalizedUrl) {
            return;
        }

        window.open(normalizedUrl, '_blank');
    }

    async function focusSearchKeyboardHost() {
        await nextTick();

        if (sessionHistory.value.length > 0) {
            conversationPanel.value?.focus();
            return;
        }

        pageContainer.value?.focus({ preventScroll: true });
    }

    async function initialize() {
        try {
            viewReady.value = false;

            await Promise.all([
                mcpStore.initialize(),
                settingsStore.initialize(),
                popupService.initialize(),
            ]);
            await syncWindowPinState().catch((error) => {
                console.error('[SearchView] Failed to sync window pin state on initialize:', error);
            });

            viewReady.value = true;

            mcpManager.autoConnect().catch((initializeError) => {
                console.error('[SearchView] Failed to auto-connect MCP servers:', initializeError);
            });
        } catch (initializeError) {
            console.error('[SearchView] Failed to initialize dependencies:', initializeError);
            viewReady.value = false;
        }
    }

    watch(
        () => sessionHistory.value.length,
        async (length, previousLength) => {
            if (!viewReady.value || length > 0 || !previousLength) {
                return;
            }

            await closeSessionHistoryPopup();
            await controller.focusSearchInput();
        },
        { flush: 'post' }
    );

    watch(
        [isLoading, pendingToolApproval],
        ([loading, approval]) => {
            if (!viewReady.value || (!loading && !approval)) {
                return;
            }

            void focusSearchKeyboardHost();
        },
        { flush: 'post' }
    );

    watch(
        sessionList,
        (sessions) => {
            refreshSessionStatuses(sessions.map((session) => session.id));
        },
        { immediate: true }
    );

    watch(
        [
            sessionHistoryPopupOpen,
            sessionList,
            sessionListQuery,
            isSessionListLoading,
            currentSessionId,
            sessionStatuses,
        ],
        ([isOpen]) => {
            if (!isOpen) {
                return;
            }

            void sessionHistoryPopup.updateData();
        },
        { flush: 'post' }
    );

    onMounted(() => {
        widgetBridgeWindow.sendPrompt = handleWidgetSendPrompt;
        widgetBridgeWindow.openLink = handleWidgetOpenLink;
        void initialize();
    });

    onUnmounted(() => {
        if (widgetBridgeWindow.sendPrompt === handleWidgetSendPrompt) {
            delete widgetBridgeWindow.sendPrompt;
        }

        if (widgetBridgeWindow.openLink === handleWidgetOpenLink) {
            delete widgetBridgeWindow.openLink;
        }
    });
</script>

<template>
    <div
        ref="pageContainer"
        tabindex="-1"
        :class="[
            'search-view-container bg-background-primary relative flex h-full w-full flex-col items-center justify-start overflow-hidden rounded-lg backdrop-blur-xl focus:outline-none',
            isLoading ? 'loading' : '',
        ]"
        @paste.capture="handlePagePaste"
    >
        <div
            v-if="viewReady && sessionHistory.length > 0"
            class="min-h-0 w-full flex-1 overflow-hidden"
        >
            <ConversationPanel
                ref="conversationPanel"
                :messages="sessionHistory"
                :is-loading="isLoading"
                :error="error"
                :is-pinned="isPinned"
                :history-open="sessionHistoryPopupOpen"
                :approval-attention-token="approvalAttentionToken"
                @pin-change="handlePinChange"
                @new-session="handleStartNewSession"
                @history-open-change="handleHistoryOpenChange"
                @history-prefetch="handleHistoryPrefetch"
                @approve-tool-approval="approvePendingToolApproval"
                @reject-tool-approval="rejectPendingToolApproval"
                @drag-start="isDragging = true"
                @drag-end="isDragging = false"
                @regenerate-message="handleRegenerateMessage"
            />
        </div>
        <div
            v-if="viewReady && sessionHistory.length > 0"
            class="w-full border-t-[0.5px] border-gray-300/80"
        ></div>
        <div v-if="viewReady" class="relative w-full">
            <SearchBar
                ref="searchBar"
                :disabled="isWaitingForCompletion || Boolean(pendingToolApproval)"
                :query-text="queryText"
                :attachments="attachments"
                :model-override="modelOverride"
                @update:query-text="handleQueryTextChange"
                @attachment-remove-request="handleAttachmentRemoveRequest"
                @model-change="handleModelChange"
                @cursor-context-change="handleCursorContextChange"
                @model-override-change="handleModelOverrideChange"
                @request-prefetch-model-dropdown="handleModelDropdownPrefetch"
                @request-toggle-model-dropdown="handleToggleModelDropdownRequest"
                @drag-start="isDragging = true"
                @drag-end="isDragging = false"
            />
            <div v-if="sessionHistory.length === 0" v-show="quickSearchOpen">
                <QuickSearchPanel
                    ref="quickSearchPanel"
                    :open="quickSearchOpen"
                    :search-query="queryText"
                    :enabled="true"
                    @blank-click="handleQuickSearchBlankClick"
                    @update:open="handleQuickSearchOpenChange"
                />
            </div>
        </div>
    </div>
</template>

<style scoped>
    .search-view-container {
        border: 1.5px solid var(--color-gray-300);
    }

    .search-view-container.loading {
        border: 2px solid transparent;
        background-image:
            linear-gradient(var(--color-background-primary), var(--color-background-primary)),
            linear-gradient(
                90deg,
                var(--color-blue-500),
                var(--color-violet-500),
                var(--color-pink-500),
                var(--color-violet-500),
                var(--color-blue-500)
            );
        background-origin: border-box;
        background-clip: padding-box, border-box;
        animation: border-flow 1.5s linear infinite;
    }

    @keyframes border-flow {
        0% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-blue-500),
                    var(--color-violet-500),
                    var(--color-pink-500),
                    var(--color-violet-500),
                    var(--color-blue-500)
                );
        }
        25% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-violet-500),
                    var(--color-pink-500),
                    var(--color-violet-500),
                    var(--color-blue-500),
                    var(--color-violet-500)
                );
        }
        50% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-pink-500),
                    var(--color-violet-500),
                    var(--color-blue-500),
                    var(--color-violet-500),
                    var(--color-pink-500)
                );
        }
        75% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-violet-500),
                    var(--color-blue-500),
                    var(--color-violet-500),
                    var(--color-pink-500),
                    var(--color-violet-500)
                );
        }
        100% {
            background-image:
                linear-gradient(var(--color-background-primary), var(--color-background-primary)),
                linear-gradient(
                    90deg,
                    var(--color-blue-500),
                    var(--color-violet-500),
                    var(--color-pink-500),
                    var(--color-violet-500),
                    var(--color-blue-500)
                );
        }
    }
</style>
