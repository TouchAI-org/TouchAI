<script setup lang="ts">
    // Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

    import { db } from '@database';
    import { mcpManager } from '@services/AiService/mcp';
    import type { SessionHistoryData } from '@services/PopupService';
    import { sendNotification } from '@tauri-apps/plugin-notification';
    import { nextTick, onMounted, reactive, ref, toRef, watch } from 'vue';

    import { useMcpStore } from '@/stores/mcp';
    import { useSettingsStore } from '@/stores/settings';

    import ConversationPanel from './components/ConversationPanel/index.vue';
    import QuickSearchPanel from './components/QuickSearchPanel/index.vue';
    import SearchBar from './components/SearchBar/index.vue';
    import {
        useQuickSearchCoordinator,
        useSearchAttachments,
        useSearchDraftController,
    } from './composables/useSearchInput';
    import {
        useSearchKeyboard,
        useSearchModelDropdownCoordinator,
        useSearchOverlayMachine,
        useSearchPageController,
        useSearchPageLifecycle,
        useSearchPanelFocusRestore,
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
        query: '',
    });
    const quickSearchOpen = ref(false);
    const quickSearchPanel = ref<QuickSearchHandle>();
    const conversationPanel = ref<ConversationPanelHandle>();
    const historyAnchorElement = ref<HTMLElement | null>(null);
    const pageContainer = ref<HTMLElement | null>(null);
    const isPinned = ref(false);
    const isDragging = ref(false);
    const mcpStore = useMcpStore();
    const settingsStore = useSettingsStore();

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
        removeAttachment,
        clearAttachments,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
        importClipboardAttachments,
    } = useSearchAttachments({
        attachments,
    });

    const { clearDraft, handlePaste } = useSearchDraftController({
        queryText,
        modelOverride,
        clearAttachments,
        importClipboardAttachments,
    });

    const {
        pendingRequest,
        isWaitingForCompletion,
        isLoading,
        error,
        currentSessionId,
        conversationHistory,
        sessionHistoryPopupOpen,
        sessionList,
        sessionListQuery,
        isSessionListLoading,
        clearConversation,
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
    } = useSearchRequestFlow({
        modelOverride,
        clearDraft,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
    });

    const { isQuickSearchOpen, shouldTriggerQuickSearch } = useQuickSearchCoordinator({
        queryText,
        attachments,
        conversationHistory,
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

    const { isDevMode, isDevBlurHideSuspended } = useSearchPageLifecycle({
        pageContainer,
        controller,
        viewReady,
        isDragging,
        isPinned,
        conversationHistory,
        clearConversation,
    });

    const {
        openModelDropdownWithLayoutSync,
        closeModelDropdown,
        hideAllDropdowns,
        handleToggleModelDropdownRequest: handleToggleModelDropdownRequestBase,
    } = useSearchModelDropdownCoordinator({
        pageContainer,
        controller,
        modelOverride,
        modelDropdownState,
        requestModelDropdownOpen,
        handleQuickSearchClosedForModelDropdown,
        handleLayoutStableForModelDropdown,
        handleModelDropdownOpened,
        handleModelDropdownClosed,
        syncOverlayState,
    });

    function getSessionHistoryPopupData(): SessionHistoryData {
        return {
            sessions: sessionList.value,
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
    });

    useSearchKeyboard({
        viewReady,
        queryText,
        cursorContext,
        modelOverride,
        modelDropdownState,
        controller,
        conversationHistory,
        pendingRequest,
        isWaitingForCompletion,
        isLoading,
        isQuickSearchOpen,
        isDevMode,
        isDevBlurHideSuspended,
        shouldTriggerQuickSearch,
        sessionHistoryPopupOpen,
        hideAllPopups,
        closeModelDropdown,
        openModelDropdown,
        handleSubmit,
        clearAll,
        cancelRequest,
        clearConversation,
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

    function handleModelDropdownStateChange(state: SearchModelDropdownState) {
        modelDropdownState.value = state;
    }

    function handleAttachmentRemoveRequest(id: string) {
        removeAttachment(id);
    }

    function handleQuickSearchOpenChange(value: boolean) {
        quickSearchOpen.value = value;
    }

    function handlePinChange(value: boolean) {
        isPinned.value = value;
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

    async function openModelDropdown() {
        await closeSessionHistoryPopup();
        await openModelDropdownWithLayoutSync();
    }

    async function handleToggleModelDropdownRequest() {
        await closeSessionHistoryPopup();
        await handleToggleModelDropdownRequestBase();
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
        controller.closeQuickSearch();
        await hideAllPopups();
        startNewSession();
        await controller.focusSearchInput();
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

            // 会话列表可能比数据库状态稍旧；若目标会话已不存在，先刷新列表再提示用户。
            if (isMissingSession) {
                void refreshSessionList().catch((refreshError) => {
                    console.error(
                        '[SearchView] Failed to refresh session history after open failure:',
                        refreshError
                    );
                });
            }

            await sendNotification({
                title: 'TouchAI - 打开会话失败',
                body: isMissingSession
                    ? '该会话不存在，历史列表已刷新'
                    : '打开会话失败，请稍后重试',
            });

            await controller.focusSearchInput();
        }
    }

    async function initialize() {
        try {
            viewReady.value = false;

            await db.init();
            await Promise.all([mcpStore.initialize(), settingsStore.initialize()]);

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
        () => conversationHistory.value.length,
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
        [
            sessionHistoryPopupOpen,
            sessionList,
            sessionListQuery,
            isSessionListLoading,
            currentSessionId,
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
        void initialize();
    });
</script>

<template>
    <div
        ref="pageContainer"
        :class="[
            'search-view-container bg-background-primary relative flex h-full w-full flex-col items-center justify-start overflow-hidden rounded-lg backdrop-blur-xl',
            isLoading ? 'loading' : '',
        ]"
        @paste="handlePaste"
    >
        <div
            v-if="viewReady && conversationHistory.length > 0"
            class="w-full flex-1 overflow-hidden"
        >
            <ConversationPanel
                ref="conversationPanel"
                :messages="conversationHistory"
                :is-loading="isLoading"
                :error="error"
                :is-pinned="isPinned"
                :toolbar-disabled="isLoading || isWaitingForCompletion"
                :history-open="sessionHistoryPopupOpen"
                @pin-change="handlePinChange"
                @new-session="handleStartNewSession"
                @history-open-change="handleHistoryOpenChange"
                @history-prefetch="handleHistoryPrefetch"
                @drag-start="isDragging = true"
                @drag-end="isDragging = false"
                @regenerate-message="handleRegenerateMessage"
            />
        </div>
        <div
            v-if="viewReady && conversationHistory.length > 0"
            class="w-full border-t-[0.5px] border-gray-300/80"
        ></div>
        <div v-if="viewReady" class="relative w-full">
            <SearchBar
                ref="searchBar"
                :disabled="isWaitingForCompletion"
                :query-text="queryText"
                :attachments="attachments"
                :model-override="modelOverride"
                @update:query-text="handleQueryTextChange"
                @attachment-remove-request="handleAttachmentRemoveRequest"
                @model-change="handleModelChange"
                @cursor-context-change="handleCursorContextChange"
                @model-override-change="handleModelOverrideChange"
                @model-dropdown-state-change="handleModelDropdownStateChange"
                @request-prefetch-model-dropdown="handleModelDropdownPrefetch"
                @request-toggle-model-dropdown="handleToggleModelDropdownRequest"
                @drag-start="isDragging = true"
                @drag-end="isDragging = false"
            />
            <div v-if="conversationHistory.length === 0" v-show="quickSearchOpen">
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
