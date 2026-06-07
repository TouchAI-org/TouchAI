<script setup lang="ts">
    // Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

    import { useSessionStatus } from '@composables/useSessionStatus';
    import type { SessionStatusReminderActionEvent } from '@services/EventService/types';
    import { storeToRefs } from 'pinia';
    import { computed, nextTick, onMounted, onUnmounted, reactive, ref, toRef, watch } from 'vue';

    import type { SessionHistoryData, SessionHistorySessionItem } from '@/contracts/popup';
    import { t } from '@/i18n';
    import type { SessionTaskStatus } from '@/services/AgentService/task/types';
    import { useSettingsStore } from '@/stores/settings';
    import {
        createInputHistorySnapshot,
        getInputHistorySnapshotKey,
        type InputHistorySnapshot,
    } from '@/types/session';
    import { isE2eTestMode } from '@/utils/runtimeMode';

    import {
        buildLatestCompletedMessageMarker,
        isSessionHistorySettled,
        shouldAutoShrinkSearchSession,
    } from './autoShrinkPolicy';
    import AskUserPanel from './components/AskUser/AskUserPanel.vue';
    import ConversationPanel from './components/ConversationPanel/index.vue';
    import QuickSearchPanel from './components/QuickSearchPanel/index.vue';
    import SearchBar from './components/SearchBar/index.vue';
    import {
        createPopupSurfaceCoordinator,
        createSearchEntryPolicy,
        createSearchInteractionContext,
        createSessionInputHistoryBrowseState,
        extractSessionInputHistoryEntries,
        navigateSessionInputHistory,
        type SessionInputHistoryBrowseState,
        type SessionInputHistoryDirection,
        type SessionInputHistoryNavigationResult,
        useQuickSearchCoordinator,
        useSearchOverlayMachine,
    } from './composables/searchInteraction';
    import { useSearchAskUserBridge } from './composables/useSearchAskUserBridge';
    import { useSearchInfrastructureController } from './composables/useSearchInfrastructureController';
    import { useSearchAttachments, useSearchDraftController } from './composables/useSearchInput';
    import {
        type QuickShortcutItem,
        useSearchNativeController,
    } from './composables/useSearchNativeController';
    import {
        useSearchKeyboard,
        useSearchModelDropdownCoordinator,
        useSearchPageController,
        useSearchPageLifecycle,
        useSearchPanelFocusRestore,
        useSearchWindowPin,
    } from './composables/useSearchPage';
    import { useSearchPopupController } from './composables/useSearchPopupController';
    import { useSearchRequestFlow } from './composables/useSearchRequest';
    import { useSearchWindowResize } from './composables/useSearchWindowResize';
    import { useSessionHistoryPopup } from './composables/useSessionHistoryPopup';
    import { initializeSearchViewForFirstPaint } from './startup';
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
        cursorAtTextStart: true,
        cursorAtEnd: true,
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
    const latestContentVisible = ref(true);
    const latestSeenCompletedMessageMarker = ref<string | null>(null);
    const inputHistoryBrowseState = ref<SessionInputHistoryBrowseState>(
        createSessionInputHistoryBrowseState()
    );
    const suppressInputHistoryBrowseReset = ref(false);
    const inputHistoryRestoreVersion = ref(0);
    const settingsStore = useSettingsStore();
    const nativeController = useSearchNativeController();
    const infrastructureController = useSearchInfrastructureController();
    const popupController = useSearchPopupController();
    const { askUserStore } = useSearchAskUserBridge();
    const { searchWindowDefaultSize } = storeToRefs(settingsStore);
    const { sessionStatuses, refreshAllStatuses: refreshSessionStatuses } = useSessionStatus();
    const { isPinned, syncWindowPinState, setWindowPinned, toggleWindowPin } = useSearchWindowPin();
    const widgetBridgeWindow = window as Window & {
        sendPrompt?: (text: string) => void;
        openLink?: (url: string) => void;
        __TOUCHAI_E2E__?: {
            openSettingsWindow: () => Promise<void>;
            openModelDropdownPopup: () => Promise<void>;
            openSessionHistoryPopup: () => Promise<void>;
            closePopups: () => Promise<void>;
            setSearchQuery: (text: string) => void;
            getQuickSearchFallbackResults?: (query: string) => QuickShortcutItem[];
        };
    };
    const searchInteractionContext = createSearchInteractionContext();
    const searchEntryPolicy = createSearchEntryPolicy();
    const popupSurfaceCoordinator = createPopupSurfaceCoordinator(searchInteractionContext);
    const suppressQuickSearchAutoOpenOnce = ref(false);
    let lastBridgedApprovalCallId: string | null = null;
    let lastBridgedQuestionCallId: string | null = null;

    function buildCurrentInputHistorySnapshot(query = queryText.value): InputHistorySnapshot {
        const capturedSnapshot = searchBar.value?.captureInputHistorySnapshot();
        return createInputHistorySnapshot({
            text: capturedSnapshot?.text ?? query,
            attachments: capturedSnapshot?.attachments ?? attachments.value,
            editorDoc: capturedSnapshot?.editorDoc,
            excludeFromHistory: capturedSnapshot?.excludeFromHistory,
        });
    }

    function applyInputHistorySnapshot(snapshot: InputHistorySnapshot) {
        const normalizedSnapshot = createInputHistorySnapshot(snapshot);
        const restoreVersion = inputHistoryRestoreVersion.value + 1;
        inputHistoryRestoreVersion.value = restoreVersion;
        suppressInputHistoryBrowseReset.value = true;

        try {
            const restoredText =
                searchBar.value?.restoreInputHistorySnapshot(normalizedSnapshot) ??
                normalizedSnapshot.text;
            attachments.value = normalizedSnapshot.attachments;
            syncAttachmentSupport();
            queryText.value = restoredText;
        } catch (error) {
            console.error('[SearchView] Failed to restore input history snapshot:', error);
            attachments.value = normalizedSnapshot.attachments;
            syncAttachmentSupport();
            queryText.value = normalizedSnapshot.text;
        } finally {
            void nextTick().then(() => {
                if (inputHistoryRestoreVersion.value === restoreVersion) {
                    suppressInputHistoryBrowseReset.value = false;
                }
            });
        }
    }

    /**
     * 判断交互上下文里的 popup 会话是否仍然对应 popupManager 当前会话。
     */
    function isLiveActivePopupSession() {
        const activeIdentity = searchInteractionContext.state.activePopupIdentity;
        return popupController.isLivePopupSession(activeIdentity);
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
        syncAttachmentSupport,
    } = useSearchAttachments({
        attachments,
    });

    const { clearDraft, importClipboardPayload } = useSearchDraftController({
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
        pendingUserQuestion,
        approvePendingToolApproval,
        rejectPendingToolApproval,
        settleUserQuestion,
        handleSubmit,
        clearAll,
        cancelRequest,
        handleRegenerateMessage: handleRegenerateMessageRequest,
    } = useSearchRequestFlow({
        modelOverride,
        clearDraft,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
        getCurrentInputSnapshot: buildCurrentInputHistorySnapshot,
    });

    const {
        contentReady: searchViewContentReady,
        isMaximized,
        effectiveWindowMaximized,
        fillConversationAvailableHeight,
        toggleMaximize: toggleMaximizeBase,
        syncWindowState: syncSearchWindowState,
        remeasureTargetHeight,
    } = useSearchWindowResize({
        target: pageContainer,
        sessionCount: computed(() => sessionHistory.value.length),
        quickSearchOpen,
        defaultSize: searchWindowDefaultSize,
        ready: viewReady,
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
        suppressNextAutoOpen: suppressQuickSearchAutoOpenOnce,
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

    const sessionIdleForAutoShrink = computed(
        () =>
            currentSessionId.value !== null &&
            !isLoading.value &&
            !pendingToolApproval.value &&
            isSessionHistorySettled(sessionHistory.value)
    );
    const latestCompletedMessageMarker = computed(() =>
        sessionIdleForAutoShrink.value
            ? buildLatestCompletedMessageMarker(currentSessionId.value, sessionHistory.value)
            : null
    );

    function syncLatestCompletedMessageSeenState() {
        const marker = latestCompletedMessageMarker.value;
        if (
            !marker ||
            !latestContentVisible.value ||
            !searchInteractionContext.state.windowVisible ||
            !searchInteractionContext.state.windowFocused
        ) {
            return;
        }

        latestSeenCompletedMessageMarker.value = marker;
    }

    function shouldClearSessionAfterTimeout() {
        return shouldAutoShrinkSearchSession({
            timedOut: true,
            sessionIdle: sessionIdleForAutoShrink.value,
            latestCompletedMessageMarker: latestCompletedMessageMarker.value,
            latestSeenCompletedMessageMarker: latestSeenCompletedMessageMarker.value,
        });
    }

    function handleLatestContentVisibilityChange(visible: boolean) {
        latestContentVisible.value = visible;
    }

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
        controller,
        viewReady,
        isDragging,
        isPinned,
        isMaximized: effectiveWindowMaximized,
        interactionContext: searchInteractionContext,
        syncWindowPinState,
        clearSession: clearSessionToIdle,
        shouldClearSessionAfterTimeout,
        reconcilePopupSurfaces: hideAllPopups,
        remeasureSearchWindowHeight: remeasureTargetHeight,
        onSurfaceHidden: clearSurfaceUiAfterHidden,
        handleSearchSurfaceCommand: async (payload) => {
            if (payload.command === 'toggle-model-dropdown') {
                await handleToggleModelDropdownRequest();
            }
        },
        handleSessionStatusReminderAction,
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

    const sessionInputHistoryEntries = computed(() =>
        extractSessionInputHistoryEntries(sessionHistory.value)
    );

    function resetInputHistoryBrowseState(entryCount = sessionInputHistoryEntries.value.length) {
        inputHistoryBrowseState.value = createSessionInputHistoryBrowseState(entryCount);
    }

    function updateActiveInputHistoryBrowseSnapshot(snapshot: InputHistorySnapshot) {
        if (inputHistoryBrowseState.value.pointer === sessionInputHistoryEntries.value.length) {
            return;
        }

        inputHistoryBrowseState.value = {
            ...inputHistoryBrowseState.value,
            activeBrowseSnapshot: createInputHistorySnapshot(snapshot),
        };
    }

    function resetSessionInputHistoryTracking() {
        inputHistoryRestoreVersion.value = 0;
        suppressInputHistoryBrowseReset.value = false;
        resetInputHistoryBrowseState();
    }

    function navigateInputHistory(
        direction: SessionInputHistoryDirection
    ): SessionInputHistoryNavigationResult {
        const result = navigateSessionInputHistory({
            entries: sessionInputHistoryEntries.value,
            currentDraft: buildCurrentInputHistorySnapshot(queryText.value),
            direction,
            state: inputHistoryBrowseState.value,
        });

        if (!result.changed) {
            if (
                direction === 'older' &&
                cursorContext.value.isMultiLine &&
                cursorContext.value.cursorAtTextStart
            ) {
                return 'blocked';
            }

            return 'ignored';
        }

        inputHistoryBrowseState.value = result.state;
        applyInputHistorySnapshot(result.nextSnapshot);
        return 'navigated';
    }

    useSearchKeyboard({
        viewReady,
        queryText,
        attachments,
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
        getActivePopupType: () =>
            isLiveActivePopupSession() ? searchInteractionContext.state.activePopupType : null,
        hasActivePopupWindowFocus: () => isLiveActivePopupSession(),
        isQuickSearchOpen,
        shouldTriggerQuickSearch,
        sessionHistoryPopupOpen,
        hideAllPopups,
        hideSearchWindow,
        navigateInputHistory,
        closeModelDropdown,
        toggleModelDropdown: handleToggleModelDropdownRequest,
        openHistoryDialog,
        startNewSession: handleStartNewSession,
        toggleWindowPin: handleToggleWindowPin,
        toggleWindowMaximize: handleToggleMaximize,
        handleSubmit,
        clearAll,
        cancelRequest,
        clearSession: clearSessionToIdle,
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
            await nativeController.notify({
                title: t('notification.pinToggleFailed.title'),
                body: t('notification.pinToggleFailed.body'),
            });
        }
    }

    function promptPendingToolApprovalAttention() {
        approvalAttentionToken.value += 1;
    }

    async function handlePagePaste(event: ClipboardEvent) {
        if (pendingToolApproval.value) {
            event.preventDefault();
            event.stopPropagation();
            promptPendingToolApprovalAttention();
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const payload = await nativeController.readExplicitPastePayload();
        if (!payload) return;

        const hasOnlyText = !payload.imagePaths?.length && !payload.filePaths?.length;

        if (hasOnlyText && payload.text) {
            const trimmedText = payload.text.trim();
            if (trimmedText) {
                searchBar.value?.insertTextAtCursor(trimmedText);
            }
            return;
        }

        if (payload.text?.trim()) {
            searchBar.value?.insertTextAtCursor(payload.text.trim());
        }

        const attachmentsToInsert: Array<{ path: string; type: 'image' | 'file' }> = [];
        for (const imagePath of payload.imagePaths ?? []) {
            attachmentsToInsert.push({ path: imagePath, type: 'image' });
        }
        for (const filePath of payload.filePaths ?? []) {
            attachmentsToInsert.push({ path: filePath, type: 'file' });
        }

        for (const { path, type } of attachmentsToInsert) {
            try {
                const attachment = await createAttachmentFromClipboardPath(type, path);
                attachments.value.push(attachment);
                searchBar.value?.insertAttachmentAtCursor(
                    attachment.id,
                    attachment.name ||
                        t(
                            type === 'image'
                                ? 'conversation.attachment.unnamedImage'
                                : 'conversation.attachment.unnamedFile'
                        ),
                    type,
                    attachment.preview
                );
            } catch (error) {
                console.error(`Failed to insert ${type} attachment:`, error);
            }
        }
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

            const payload = await nativeController.consumeShortcutAutoPastePayload(3000);
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
        if (sessionHistoryPopupOpen.value || popupController.isSessionHistoryOpen()) {
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

    async function clearSessionToIdle() {
        suppressQuickSearchAutoOpenOnce.value = true;
        clearSession();
        await nextTick();
        await controller.focusSearchInput();
    }

    async function handleStartNewSession() {
        if (sessionHistory.value.length === 0) {
            return;
        }

        controller.closeQuickSearch();
        await hideAllPopups();
        startNewSession();
        resetSessionInputHistoryTracking();
        await controller.focusSearchInput();
    }

    async function handleToggleWindowPin() {
        try {
            await toggleWindowPin();
        } catch (error) {
            console.error('[SearchView] Failed to toggle window pin state:', error);
            await nativeController.notify({
                title: t('notification.pinToggleFailed.title'),
                body: t('notification.pinToggleFailed.body'),
            });
        }
    }

    async function handleToggleMaximize() {
        try {
            await hideAllPopups();
            await toggleMaximizeBase();
        } catch (error) {
            console.error('[SearchView] Failed to toggle maximized state:', error);
        }
    }

    async function handleOpenSession(sessionId: number) {
        controller.closeQuickSearch();
        await hideAllPopups();
        resetSessionInputHistoryTracking();

        try {
            await openSession(sessionId);
            await syncSearchWindowState().catch((error) => {
                console.error(
                    '[SearchView] Failed to sync search window state after session open:',
                    error
                );
            });
            await remeasureTargetHeight().catch((error) => {
                console.error(
                    '[SearchView] Failed to remeasure window height after session open:',
                    error
                );
            });
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

            await nativeController.notify({
                title: t('notification.openSessionFailed.title'),
                body: t(
                    isMissingSession
                        ? 'notification.openSessionFailed.missing'
                        : 'notification.openSessionFailed.generic'
                ),
            });

            await controller.focusSearchInput();
        }
    }

    async function submitStatusReminderReply(replyText: string) {
        const normalizedReply = replyText.trim();
        if (!normalizedReply) {
            return;
        }

        const replySnapshot = createInputHistorySnapshot({
            text: normalizedReply,
            attachments: [],
        });
        await handleSubmit(normalizedReply, replySnapshot);
    }

    async function handleSessionStatusReminderAction(payload: SessionStatusReminderActionEvent) {
        controller.closeQuickSearch();
        await hideAllPopups();

        const requiresSessionOpen =
            currentSessionId.value !== payload.sessionId ||
            (payload.callId && pendingToolApproval.value?.callId !== payload.callId);

        if (requiresSessionOpen) {
            await handleOpenSession(payload.sessionId);
        }

        if (currentSessionId.value !== payload.sessionId) {
            return;
        }

        if (payload.action === 'approve') {
            approvePendingToolApproval(payload.callId ?? undefined);
            return;
        }

        if (payload.action === 'reject') {
            rejectPendingToolApproval(payload.callId ?? undefined);
            return;
        }

        if (payload.action === 'reply') {
            await submitStatusReminderReply(payload.replyText ?? '');
            return;
        }

        conversationPanel.value?.revealLatestContent();
        if (payload.kind === 'waiting_approval') {
            promptPendingToolApprovalAttention();
        }
    }

    async function handleRegenerateMessage(messageId: string) {
        await handleRegenerateMessageRequest(messageId);
    }

    function applyE2eSearchQuery(nextText: string) {
        const snapshot = createInputHistorySnapshot({
            text: nextText,
            attachments: [],
        });
        const restoredText =
            searchBar.value?.restoreInputHistorySnapshot(snapshot) ?? snapshot.text;
        attachments.value = snapshot.attachments;
        syncAttachmentSupport();
        queryText.value = restoredText;
    }

    function getE2eQuickSearchFallbackResults(query: string): QuickShortcutItem[] {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery.includes('touchai')) {
            return [];
        }

        return [
            {
                name: 'TouchAI E2E Smoke Result',
                path: 'C:/Windows/explorer.exe',
                source: 'file',
            },
        ];
    }

    async function installE2eBridge() {
        if (!(await isE2eTestMode())) {
            return;
        }

        widgetBridgeWindow.__TOUCHAI_E2E__ = {
            async openSettingsWindow() {
                await nativeController.openSettingsWindow();
            },
            async openModelDropdownPopup() {
                await hideAllPopups();
                await handleToggleModelDropdownRequest();
            },
            async openSessionHistoryPopup() {
                await hideAllPopups();
                await openHistoryDialog();
            },
            async closePopups() {
                await hideAllPopups();
            },
            setSearchQuery(text: string) {
                applyE2eSearchQuery(text);
            },
            getQuickSearchFallbackResults(query: string) {
                return getE2eQuickSearchFallbackResults(query);
            },
        };
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

        const widgetSnapshot = createInputHistorySnapshot({
            text: normalizedText,
            attachments: [],
            excludeFromHistory: true,
        });
        void handleSubmit(normalizedText, widgetSnapshot);
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
        await initializeSearchViewForFirstPaint({
            initializeSettings: () => settingsStore.initialize(),
            initializeMcpStore: () => infrastructureController.initializeMcpStore(),
            initializePopups: () => popupController.initialize(),
            syncWindowPinState,
            syncSearchWindowState,
            isE2eTestMode,
            autoConnectMcp: async () => {
                await infrastructureController.autoConnectMcp();
            },
            onReady: (ready) => {
                viewReady.value = ready;
            },
            logError: (message, error) => {
                console.error(message, error);
            },
        });
    }

    watch(
        () => ({
            marker: latestCompletedMessageMarker.value,
            latestContentVisible: latestContentVisible.value,
            windowVisible: searchInteractionContext.state.windowVisible,
            windowFocused: searchInteractionContext.state.windowFocused,
        }),
        () => {
            syncLatestCompletedMessageSeenState();
        },
        { flush: 'post' }
    );

    watch(
        sessionInputHistoryEntries,
        (entries, previousEntries) => {
            const previousLength = previousEntries?.length ?? 0;
            const nextLength = entries.length;
            const currentPointer = inputHistoryBrowseState.value.pointer;

            if (currentPointer === previousLength) {
                inputHistoryBrowseState.value = {
                    ...inputHistoryBrowseState.value,
                    pointer: nextLength,
                };
                return;
            }

            if (currentPointer > nextLength) {
                resetInputHistoryBrowseState(nextLength);
            }
        },
        { flush: 'sync' }
    );

    watch(
        () =>
            getInputHistorySnapshotKey(
                createInputHistorySnapshot({
                    text: queryText.value,
                    attachments: attachments.value,
                })
            ),
        (value, previousValue) => {
            if (value === previousValue) {
                return;
            }

            if (suppressInputHistoryBrowseReset.value) {
                return;
            }

            if (inputHistoryBrowseState.value.pointer === sessionInputHistoryEntries.value.length) {
                return;
            }

            updateActiveInputHistoryBrowseSnapshot(
                buildCurrentInputHistorySnapshot(queryText.value)
            );
        },
        { flush: 'sync' }
    );

    watch(
        () => sessionHistory.value.length,
        async (length, previousLength) => {
            if (!viewReady.value || length > 0 || !previousLength) {
                return;
            }

            latestSeenCompletedMessageMarker.value = null;
            latestContentVisible.value = true;
            resetSessionInputHistoryTracking();
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

    // Bridge: sync pendingToolApproval from projection into askUser store
    watch(
        pendingToolApproval,
        (approval) => {
            if (approval) {
                if (lastBridgedApprovalCallId === approval.callId) return;
                lastBridgedApprovalCallId = approval.callId;
                controller.closeQuickSearch();
                void hideAllPopups().catch((error) => {
                    console.error(
                        '[SearchView] failed to hide popups before approval prompt',
                        error
                    );
                });
                askUserStore.enqueueApproval(
                    {
                        callId: approval.callId,
                        title: approval.title,
                        description: approval.description,
                        command: approval.command,
                        riskLabel: approval.riskLabel,
                        reason: approval.reason,
                        commandLabel: '命令预览',
                        approveLabel: approval.approveLabel,
                        rejectLabel: approval.rejectLabel,
                        enterHint: approval.enterHint,
                        escHint: approval.escHint,
                        keyboardApproveDelayMs: approval.keyboardApproveAt
                            ? Math.max(0, approval.keyboardApproveAt - Date.now())
                            : 450,
                    },
                    (approved) => {
                        if (approved) {
                            approvePendingToolApproval(approval.callId);
                        } else {
                            rejectPendingToolApproval(approval.callId);
                        }
                    }
                );
            } else {
                // Approval resolved externally (e.g. task cancelled)
                if (lastBridgedApprovalCallId) {
                    askUserStore.cancelByApprovalCallId(lastBridgedApprovalCallId);
                    lastBridgedApprovalCallId = null;
                }
            }
        },
        { flush: 'post' }
    );

    // Bridge: sync pendingUserQuestion from projection into askUser store
    watch(
        pendingUserQuestion,
        (question) => {
            if (question) {
                if (lastBridgedQuestionCallId === question.callId) return;
                lastBridgedQuestionCallId = question.callId;
                controller.closeQuickSearch();
                void hideAllPopups().catch((error) => {
                    console.error(
                        '[SearchView] failed to hide popups before question prompt',
                        error
                    );
                });
                askUserStore.enqueueQuestion(
                    question.questions,
                    (answers) => {
                        settleUserQuestion(question.callId, answers);
                    },
                    { sourceCallId: question.callId }
                );
            } else {
                if (lastBridgedQuestionCallId) {
                    askUserStore.cancelByQuestionCallId(lastBridgedQuestionCallId);
                    lastBridgedQuestionCallId = null;
                }
            }
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
        void installE2eBridge();
        void initialize();
    });

    onUnmounted(() => {
        if (widgetBridgeWindow.sendPrompt === handleWidgetSendPrompt) {
            delete widgetBridgeWindow.sendPrompt;
        }

        if (widgetBridgeWindow.openLink === handleWidgetOpenLink) {
            delete widgetBridgeWindow.openLink;
        }

        if (widgetBridgeWindow.__TOUCHAI_E2E__) {
            delete widgetBridgeWindow.__TOUCHAI_E2E__;
        }
    });
</script>

<template>
    <div
        ref="pageContainer"
        tabindex="-1"
        data-testid="search-view"
        :class="[
            'search-view-container bg-background-primary relative flex min-h-0 w-full flex-col items-center justify-start overflow-hidden backdrop-blur-xl focus:outline-none',
            fillConversationAvailableHeight || effectiveWindowMaximized ? 'h-full' : '',
            isLoading && !askUserStore.current ? 'loading' : '',
        ]"
        @paste.capture="handlePagePaste"
    >
        <div
            v-if="searchViewContentReady && sessionHistory.length > 0"
            :class="[
                'w-full overflow-hidden',
                fillConversationAvailableHeight ? 'min-h-0 flex-1' : '',
            ]"
        >
            <ConversationPanel
                ref="conversationPanel"
                :messages="sessionHistory"
                :is-loading="isLoading"
                :error="error"
                :is-pinned="isPinned"
                :is-maximized="isMaximized"
                :fill-available-height="fillConversationAvailableHeight"
                :history-open="sessionHistoryPopupOpen"
                @pin-change="handlePinChange"
                @maximize-toggle="handleToggleMaximize"
                @new-session="handleStartNewSession"
                @history-open-change="handleHistoryOpenChange"
                @history-prefetch="handleHistoryPrefetch"
                @drag-start="isDragging = true"
                @drag-end="isDragging = false"
                @regenerate-message="handleRegenerateMessage"
                @latest-content-visibility-change="handleLatestContentVisibilityChange"
            />
        </div>
        <div
            v-if="searchViewContentReady && sessionHistory.length > 0 && !askUserStore.current"
            class="w-full border-t-[0.5px] border-gray-300/80"
        ></div>
        <div
            v-if="searchViewContentReady && askUserStore.current"
            aria-hidden="true"
            class="ask-user-divider relative z-10 w-full"
        ></div>
        <AskUserPanel v-if="searchViewContentReady && askUserStore.current" />
        <div v-if="viewReady && !askUserStore.current" class="relative w-full">
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
            <div
                v-if="searchViewContentReady && sessionHistory.length === 0"
                v-show="quickSearchOpen"
            >
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
