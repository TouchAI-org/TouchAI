<script setup lang="ts">
    // Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

    import { useMotion } from '@composables/useMotion';
    import { useSessionStatus } from '@composables/useSessionStatus';
    import { AppEvent, eventService } from '@services/EventService';
    import type {
        SearchSurfaceCommandEvent,
        SessionStatusReminderActionEvent,
    } from '@services/EventService/types';
    import type { QuickShortcutItem } from '@services/NativeService';
    import { native } from '@services/NativeService';
    import { notify } from '@services/NotificationService';
    import { log } from '@services/ObservabilityService';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { storeToRefs } from 'pinia';
    import { useStateMachine } from 'reka-ui';
    import { computed, nextTick, onMounted, onUnmounted, reactive, ref, toRef, watch } from 'vue';

    import type { SearchKeybindingActionId } from '@/config/searchKeybindings';
    import {
        SEARCH_SURFACE_EASING,
        SEARCH_SURFACE_MOTION,
        SEARCH_SURFACE_REVEAL_EASING,
    } from '@/config/searchWindow';
    import { type AppLocale, t } from '@/i18n';
    import type { ToolApprovalDecisionRequest } from '@/services/AgentService/contracts/tooling';
    import { mcpManager } from '@/services/AgentService/infrastructure/mcp';
    import type { SessionTaskStatus } from '@/services/AgentService/task/types';
    import { clipboardService } from '@/services/ClipboardService';
    import type {
        ClipboardPayload,
        SearchSurfacePreparation,
        SearchWindowState,
    } from '@/services/NativeService/types';
    import type { SearchActionOutcome, SearchActivationContext } from '@/services/SearchService';
    import { type AskUserConfirmOptions, useAskUserStore } from '@/stores/askUser';
    import { useMcpStore } from '@/stores/mcp';
    import { useSettingsStore } from '@/stores/settings';
    import {
        createInputHistorySnapshot,
        getInputHistorySnapshotKey,
        type InputHistorySnapshot,
        type SessionMessage,
    } from '@/types/session';
    import { isE2eTestMode } from '@/utils/runtimeMode';

    import {
        buildLatestCompletedMessageMarker,
        isSessionHistorySettled,
        shouldAutoShrinkSearchSession,
    } from './autoShrinkPolicy';
    import AskUserPanel from './components/AskUser/AskUserPanel.vue';
    import ConversationPanel from './components/ConversationPanel/index.vue';
    import ModelDropdownPopup from './components/ModelDropdownPopup/index.vue';
    import QuickSearchPanel from './components/QuickSearchPanel/index.vue';
    import SearchBar from './components/SearchBar/index.vue';
    import SkillPickerPanel from './components/SearchBar/SkillPickerPanel.vue';
    import type { FilePickerContext } from './components/SearchBar/types';
    import SearchOverlayHost from './components/SearchOverlayHost/index.vue';
    import type { SearchOverlayPosition } from './components/SearchOverlayHost/position';
    import SearchPanelResizeHandles from './components/SearchPanelResizeHandles/index.vue';
    import SessionHistoryPopover from './components/SessionHistoryPopover/index.vue';
    import {
        createSearchEntryPolicy,
        createSearchInteractionContext,
        createSessionInputHistoryBrowseState,
        extractSessionInputHistoryEntries,
        navigateSessionInputHistory,
        type SessionInputHistoryBrowseState,
        type SessionInputHistoryDirection,
        type SessionInputHistoryNavigationResult,
        useQuickSearchCoordinator,
    } from './composables/searchInteraction';
    import { useSearchAttachments, useSearchDraftController } from './composables/useSearchInput';
    import {
        filterModelDropdownItems,
        useSearchKeyboard,
        useSearchPageController,
        useSearchPageLifecycle,
        useSearchPanelFocusRestore,
        useSearchWindowPin,
    } from './composables/useSearchPage';
    import { useSearchPanelDragging } from './composables/useSearchPanelDragging';
    import { useSearchPanelInteraction } from './composables/useSearchPanelInteraction';
    import { useSearchPanelResizing } from './composables/useSearchPanelResizing';
    import { useSearchRequestFlow } from './composables/useSearchRequest';
    import { useSearchWindowResize } from './composables/useSearchWindowResize';
    import {
        createSearchSurfacePreparationController,
        settleSearchSurfaceViewport,
    } from './searchSurfacePreparation';
    import {
        createSearchWindowRegionReporter,
        createSearchWindowRegionSignature,
        resolveSearchWindowRegionGeometry,
        validateSearchSurfacePreparationUpdate,
    } from './searchWindowRegions';
    import { initializeSearchViewForFirstPaint } from './startup';
    import type {
        ModelDropdownData,
        ModelDropdownItem,
        SessionHistoryData,
        SessionHistorySessionItem,
    } from './types';
    import type {
        ConversationPanelHandle,
        QuickSearchHandle,
        SearchBarHandle,
        SearchCursorContext,
        SearchDraftState,
        SearchModelDropdownState,
        SearchModelOverride,
    } from './types';
    import {
        canAutoPasteIntoDraft,
        clipboardPayloadHasAttachmentFragments,
        trimClipboardPayloadTextBoundary,
    } from './utils/clipboardDraft';
    import { resolveAutoSessionPanelHeight } from './windowSizing';
    defineOptions({
        name: 'SearchViewPage',
    });

    const viewReady = ref(false);
    const { duration, setWindowVisible } = useMotion();
    const surfaceAnimationDuration = computed(() => duration(SEARCH_SURFACE_MOTION.durationMs));
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
    type ActiveSearchOverlay = 'none' | 'model-dropdown' | 'session-history';
    type OverlayContentHandle = {
        handleOverlayShown: () => void;
        handleKeyDown: (event: KeyboardEvent) => void;
    };
    type OverlayHostHandle = { refreshPosition: () => Promise<void> };
    const activeOverlay = ref<ActiveSearchOverlay>('none');
    const renderedOverlay = ref<ActiveSearchOverlay>('none');
    const overlayAnchorElement = ref<HTMLElement | null>(null);
    const overlayPositionAnchorElement = ref<HTMLElement | null>(null);
    /**
     * Gap between a popup and the element it hangs from.
     *
     * A popup that floats over the results list sits flush with the search box's bottom edge, because
     * that edge is the list's top: any gap shows a strip of the list between the box and the popup.
     * Every other popup keeps the small gap it uses to read as attached but separate.
     */
    const overlayPositionGap = ref(5);
    /** Left edge reference for a popup that floats over the results list. */
    const overlayLeftAlignElement = ref<HTMLElement | null>(null);
    /**
     * Whether the open popup covers the results list instead of hanging beside its own control.
     *
     * Only the model picker does that, and only while the list is open. It is asked here rather than
     * inferred from the reference above: that reference is kept for the popup it was resolved for,
     * and a later popup reading a leftover value would be positioned as if it floated over the list
     * -- which put the session history at the top of the window.
     */
    const overlayFloatsOverResults = computed(
        () => quickSearchOpen.value && overlayLeftAlignElement.value !== null
    );
    /**
     * The element a popup covers when the results list is showing.
     *
     * It defines both edges: its left is the surface's, and its top is where the list starts. A popup
     * opened over the list uses it instead of its own (inset) control.
     */
    function resolveResultsSlotElement(): HTMLElement | null {
        return document.querySelector<HTMLElement>("[data-testid='quick-search-handoff-shell']");
    }

    /**
     * Point the overlay host at the results slot (or back at the default placement).
     *
     * Every popup follows one rule while the list is open: it covers the list instead of hanging
     * beside its control, because the list is what the user is reading and it must neither collapse
     * nor push the popup under itself.
     */
    function alignOverlayToResultsSlot(floating: boolean) {
        if (floating) {
            const slot = resolveResultsSlotElement();
            overlayLeftAlignElement.value = slot;
            overlayPositionGap.value = slot ? 0 : 5;
            return;
        }

        overlayLeftAlignElement.value = null;
        overlayPositionGap.value = 5;
    }

    const overlayHost = ref<OverlayHostHandle>();
    const modelDropdownOverlay = ref<OverlayContentHandle>();
    const sessionHistoryPopover = ref<OverlayContentHandle>();
    let pendingOverlayFocus: ActiveSearchOverlay = 'none';
    let pendingOverlayFocusEpoch = 0;
    let overlayIntentEpoch = 0;
    let pendingModelOpenEpoch: number | null = null;
    const modelDropdownQuery = ref('');
    const quickSearchOpen = ref(false);
    const skillAutocompleteOpen = ref(false);
    const skillInputActive = ref(false);
    const fileInputActive = ref(false);
    const fileAutocompleteQuery = ref<string | null>(null);
    const filePickerContext = ref<FilePickerContext | null>(null);
    const fileSearchEnabled = computed(
        () =>
            fileAutocompleteQuery.value !== null ||
            (!skillInputActive.value && !fileInputActive.value)
    );
    // Keep QuickSearch mounted while a submitted query hands the surface to the
    // conversation panel. The shell then collapses in CSS instead of disappearing.
    const quickSearchHandoffLifecycle = useStateMachine('idle', {
        idle: { begin: 'holding', dispose: 'disposed' },
        holding: { close: 'closing', finish: 'idle', dispose: 'disposed' },
        closing: { finish: 'idle', dispose: 'disposed' },
        disposed: {},
    });
    const quickSearchHandoff = computed(
        () =>
            quickSearchHandoffLifecycle.state.value === 'holding' ||
            quickSearchHandoffLifecycle.state.value === 'closing'
    );
    const quickSearchHandoffClosing = computed(
        () => quickSearchHandoffLifecycle.state.value === 'closing'
    );
    const quickSearchPanel = ref<QuickSearchHandle>();
    function captureSearchActivationContext(): Partial<SearchActivationContext> {
        return {
            input: searchBar.value?.captureSearchActivationInput?.(),
            conversation:
                currentSessionId.value !== null ? { sessionId: currentSessionId.value } : null,
        };
    }
    function handleSearchActionOutcome(outcome: SearchActionOutcome) {
        const messages = {
            'requires-conversation': 'search.results.requiresConversation',
            'requires-permissions': 'search.results.requiresPermissions',
            unavailable: 'search.results.unavailable',
            unsupported: 'search.results.unavailable',
            failed: 'search.results.actionFailed',
        } as const;
        if (outcome.status in messages)
            notify({
                title: t('search.results.open'),
                body: t(messages[outcome.status as keyof typeof messages]),
            });
    }
    const skillPickerPanel = ref<InstanceType<typeof SkillPickerPanel>>();
    const quickSearchHandoffShell = ref<HTMLElement | null>(null);
    type QuickSearchRevealPhase = 'idle' | 'measuring' | 'open' | 'folding' | 'handoff';
    const quickSearchRevealPhase = ref<QuickSearchRevealPhase>('idle');
    let quickSearchRevealEpoch = 0;
    let quickSearchHandoffClosePromise: Promise<void> | null = null;
    let sessionExpansion: AbortController | null = null;
    const conversationPanel = ref<ConversationPanelHandle>();
    const conversationContainer = ref<HTMLElement | null>(null);
    const pageContainer = ref<HTMLElement | null>(null);
    const inputArea = ref<HTMLElement | null>(null);
    const pickerContainer = ref<HTMLElement | null>(null);
    const pageContent = ref<HTMLElement | null>(null);
    const searchViewCard = ref<HTMLElement | null>(null);
    const overlayRegionElement = ref<HTMLElement | null>(null);
    const overlayRequiredViewportHeight = ref<number | null>(null);
    const overlayPositionReady = ref(false);
    const closeOverlayImmediately = ref(false);
    let overlaySettleInFlightEpoch: number | null = null;
    let overlaySettleEpoch = 0;
    const quickSearchRevealPending = computed(() => quickSearchRevealPhase.value === 'measuring');
    const surfaceHiding = ref(false);

    const {
        active: isDragging,
        begin: beginSearchPanelInteraction,
        end: endSearchPanelInteraction,
    } = useSearchPanelInteraction({
        onFirstStart: () => {
            void hideAllOverlays(false);
            scheduleSearchWindowRegionSync(true, true);
        },
        onLastEnd: () => {
            void nextTick().then(() => {
                if (isDragging.value) return;
                overlayHost.value?.refreshPosition();
                scheduleSearchWindowRegionSync(true, true);
            });
        },
    });
    let searchViewListenersDisposed = false;
    let notifySearchSurfaceViewportChanged: () => void = () => undefined;
    const searchWindowRegionReporter = createSearchWindowRegionReporter<SearchSurfacePreparation>(
        (preparation) => {
            if (!viewReady.value) return null;
            if (surfaceHiding.value && !preparation) return null;
            const surface = pageContainer.value;
            if (!surface) return null;

            const { regions } = resolveSearchWindowRegionGeometry(
                surface.getBoundingClientRect(),
                overlayRegionElement.value?.getBoundingClientRect() ?? null,
                isLogicalPanelResizing.value || effectiveWindowMaximized.value
                    ? { width: window.innerWidth, height: window.innerHeight }
                    : null
            );
            if (regions.length === 0) return null;

            return {
                signature: createSearchWindowRegionSignature(regions),
                report: async (
                    generation: number,
                    preparation: SearchSurfacePreparation | undefined
                ) => {
                    try {
                        const update = await native.window.setSearchWindowRegions(
                            regions,
                            generation,
                            preparation
                        );
                        return validateSearchSurfacePreparationUpdate(
                            update,
                            preparation,
                            generation
                        );
                    } catch (error) {
                        log.error('[SearchView] Failed to sync search window regions:', error);
                        throw error;
                    }
                },
            };
        },
        100,
        handleRegionSyncFailure
    );
    const approvalAttentionToken = ref(0);
    const latestContentVisible = ref(true);
    const latestSeenCompletedMessageMarker = ref<string | null>(null);
    const inputHistoryBrowseState = ref<SessionInputHistoryBrowseState>(
        createSessionInputHistoryBrowseState()
    );
    const suppressInputHistoryBrowseReset = ref(false);
    const inputHistoryRestoreVersion = ref(0);
    const mcpStore = useMcpStore();
    const settingsStore = useSettingsStore();
    const { searchWindowDefaultSize, searchKeybindings } = storeToRefs(settingsStore);
    const { sessionStatuses, refreshAllStatuses: refreshSessionStatuses } = useSessionStatus();
    const { isPinned, syncWindowPinState, setWindowPinned, toggleWindowPin } = useSearchWindowPin();
    type E2eAskUserRequest =
        | { kind: 'confirm'; options: AskUserConfirmOptions }
        | { kind: 'approval'; payload: ToolApprovalDecisionRequest };
    const widgetBridgeWindow = window as Window & {
        sendPrompt?: (text: string) => void;
        openLink?: (url: string) => void;
        __TOUCHAI_E2E__?: {
            openSettingsWindow: () => Promise<void>;
            setSearchQuery: (text: string) => void;
            sendPrompt: (text: string) => Promise<void>;
            getSearchWindowState: () => Promise<SearchWindowState>;
            resizeWindowHeight: typeof native.window.resizeWindowHeight;
            resetSearchWindowBounds: () => Promise<void>;
            setSearchFixture: (query: string, results: QuickShortcutItem[]) => void;
            setConversation: (messages: SessionMessage[]) => void;
            setAskUserRequest: (request: E2eAskUserRequest) => void;
            clearAskUser: () => void;
            setLanguage: (locale: AppLocale) => Promise<void>;
            getQuickSearchFallbackResults?: (query: string) => QuickShortcutItem[];
            resetDraft?: () => void;
            clearSessionToIdle?: () => Promise<void>;
            getSessionExpandDebug?: () => { events: unknown[] } | null;
        };
    };
    const searchInteractionContext = createSearchInteractionContext();
    const searchEntryPolicy = createSearchEntryPolicy();
    const suppressQuickSearchAutoOpenOnce = ref(false);
    const askUserStore = useAskUserStore();
    let lastBridgedApprovalCallId: string | null = null;
    let lastBridgedQuestionCallId: string | null = null;

    function scheduleSearchWindowRegionSync(force = false, immediate = false) {
        searchWindowRegionReporter.schedule('geometry', force, immediate);
    }

    function handleRegionSyncFailure(error: unknown) {
        log.error('[SearchView] Failed to prepare search window region:', error);
        surfaceHiding.value = true;
        void native.window.hideSearchWindow().catch((hideError) => {
            log.error('[SearchView] Failed to hide unsafe search window region:', hideError);
        });
    }

    async function preparePanelTransition() {
        try {
            await searchWindowRegionReporter.flush('panel-transition', true);
        } catch (error) {
            handleRegionSyncFailure(error);
            throw error;
        }
    }

    function beginOverlayIntent() {
        overlayIntentEpoch += 1;
        pendingModelOpenEpoch = null;
        return overlayIntentEpoch;
    }

    function isOverlayIntentCurrent(intentEpoch: number) {
        return intentEpoch === overlayIntentEpoch;
    }

    function clearPendingOverlayFocus() {
        pendingOverlayFocus = 'none';
        pendingOverlayFocusEpoch = 0;
    }

    function handleOverlayRegionChange(element: HTMLElement | null) {
        overlayRegionElement.value = element;
        if (!element) overlayRequiredViewportHeight.value = null;
        searchWindowRegionReporter.schedule('overlay-transition-envelope', false, true);
        void remeasureTargetHeight().catch((error) => {
            log.error('[SearchView] Failed to remeasure inline overlay bounds:', error);
        });
    }

    function handleOverlayAfterLeave() {
        if (activeOverlay.value === 'none') {
            overlayPositionReady.value = false;
            renderedOverlay.value = 'none';
            overlayAnchorElement.value = null;
            overlayPositionAnchorElement.value = null;
        }
    }

    function handleLogicalPanelHeightChange() {
        void nextTick().then(() => {
            if (searchViewListenersDisposed) return;
            scheduleSearchWindowRegionSync(true, true);
        });
    }

    function handleLogicalPanelGeometryChange() {
        handleHostViewportChange();
    }

    function handleHostViewportChange() {
        notifySearchSurfaceViewportChanged();
        void nextTick().then(() => {
            settleQuickSearchReveal();
            if (activeOverlay.value !== 'none') {
                void overlayHost.value?.refreshPosition();
            }
            scheduleSearchWindowRegionSync(true, true);
        });
    }

    function overlayFitsViewport() {
        return (
            overlayRequiredViewportHeight.value === null ||
            document.documentElement.clientHeight >= overlayRequiredViewportHeight.value - 1
        );
    }

    function buildCurrentInputHistorySnapshot(query = queryText.value): InputHistorySnapshot {
        const capturedSnapshot = searchBar.value?.captureInputHistorySnapshot();
        return createInputHistorySnapshot({
            text: capturedSnapshot?.text ?? query,
            attachments: capturedSnapshot?.attachments ?? attachments.value,
            editorDoc: capturedSnapshot?.editorDoc,
            skills: capturedSnapshot?.skills,
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
            log.error('[SearchView] Failed to restore input history snapshot:', error);
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
        createAttachmentFromSearchResult,
        removeAttachment,
        restoreAttachment,
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
        clearEditor: () =>
            searchBar.value?.restoreInputHistorySnapshot(
                createInputHistorySnapshot({ text: '', attachments: [] })
            ),
    });

    const requestDraftClear = (options?: { preserveModelTag?: boolean }) => {
        clearDraft(options);
    };

    const {
        pendingRequest,
        isWaitingForCompletion,
        isLoading,
        error,
        currentSessionId,
        sessionHistory,
        sessionHistoryOverlayOpen,
        sessionList,
        sessionListQuery,
        isSessionListLoading,
        clearSession,
        setSessionHistoryOverlayOpen,
        beginHistoryInteraction,
        markHistorySelectionPending,
        abandonHistorySelection,
        reportHistoryInteractionOpened,
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
        handleRegenerateMessage: handleRegenerateMessageRequest,
    } = useSearchRequestFlow({
        modelOverride,
        clearDraft: requestDraftClear,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
        getCurrentInputSnapshot: buildCurrentInputHistorySnapshot,
    });

    const floatingPicker = computed(
        () => sessionHistory.value.length > 0 && !quickSearchHandoff.value
    );

    const {
        contentReady: searchViewContentReady,
        cardHeight: cardPixelHeight,
        measurementHold: surfaceMeasurementHold,
        isMaximized,
        effectiveWindowMaximized,
        settledWindowMaximized,
        fillConversationAvailableHeight,
        skillPickerMaxHeight,
        filePickerMaxHeight,
        monitorHost: usesMonitorHost,
        panelBounds,
        overlayMaxViewportHeight,
        overlayMinViewportTop,
        overlayMinViewportLeft,
        overlayMaxViewportRight,
        panelStyle,
        cardStyle,
        isSessionExpandAnimating,
        isCardGrowing,
        allowLogicalPanelHeightResize,
        toggleMaximize: toggleMaximizeBase,
        syncWindowState: syncSearchWindowState,
        remeasureTargetHeight,
        measureTargetHeight,
        scheduleMeasurement: scheduleContentMeasurement,
        playSessionExpandAnimation,
        collapseSessionToIdle,
        resetSearchWindowBounds,
        beginLogicalPanelResize,
        previewLogicalPanelResize,
        commitLogicalPanelResize,
        cancelLogicalPanelResize,
        prepareForNativeDrag,
        finishNativeDrag,
        isLogicalPanelResizing,
    } = useSearchWindowResize({
        askUserOpen: computed(() => Boolean(askUserStore.current)),
        target: pageContent,
        inputArea,
        picker: pickerContainer,
        floatingPicker,
        measureContentHeight: measurePageContentHeight,
        overlayTarget: overlayRegionElement,
        // The animated height belongs to the opaque card. The outer frame
        // keeps the committed host geometry stable so its radius and shadow
        // do not move while the session content is revealed.
        card: searchViewCard,
        overlayRequiredViewportHeight,
        intrinsicHeightMeasurementPending: quickSearchRevealPending,
        sessionCount: computed(() => sessionHistory.value.length),
        quickSearchOpen,
        skillAutocompleteOpen,
        defaultSize: searchWindowDefaultSize,
        ready: viewReady,
        onLogicalPanelHeightChange: handleLogicalPanelHeightChange,
        preparePanelTransition,
        onLogicalPanelGeometryChange: handleLogicalPanelGeometryChange,
        onHostViewportChange: handleHostViewportChange,
        resizeEnabled: computed(() => !surfaceHiding.value),
    });

    // The card is the panel, not the host interior: a fixed overlay reserves host height
    // below the panel, and the card animates its own growth into the committed host. Both
    // cases need the card height to come from the committed panel height.
    const searchSurfaceStyle = computed(() => {
        const borderWidth = panelStyle.value?.['--search-surface-border-width'];
        const style: Record<string, string> = {
            '--search-surface-duration': `${surfaceAnimationDuration.value}ms`,
            '--search-surface-easing': SEARCH_SURFACE_EASING,
            '--search-reveal-duration': `${duration(SEARCH_SURFACE_MOTION.revealDurationMs)}ms`,
            '--search-reveal-easing': SEARCH_SURFACE_REVEAL_EASING,
        };
        if (borderWidth) {
            style['--search-surface-border-width'] = borderWidth;
        }
        const panelHeight = cardPixelHeight.value;
        if (panelHeight && !effectiveWindowMaximized.value) {
            style['--search-surface-card-height'] = `${panelHeight}px`;
        }

        return style;
    });

    const pageContentMaxHeight = computed(() =>
        resolveAutoSessionPanelHeight({
            searchBarHeight: searchWindowDefaultSize.value.height,
        })
    );
    const pageContentStyle = computed(() => {
        if (!floatingPicker.value && (quickSearchOpen.value || skillAutocompleteOpen.value)) {
            return { height: '100%', flex: '1 1 0%', maxHeight: 'none' };
        }
        if (
            sessionHistory.value.length > 0 ||
            fillConversationAvailableHeight.value ||
            effectiveWindowMaximized.value
        ) {
            return { maxHeight: 'none' };
        }

        // Intrinsic content box: the native host follows the measurement, the card
        // clips the overflow while it catches up. A stretched flex child was what
        // stopped text wrapping from resizing the window and stretched the editor.
        return {
            flex: '0 0 auto',
            maxHeight: `${pageContentMaxHeight.value}px`,
        };
    });

    const {
        startDragging: startSearchPanelDragging,
        cancelDragging: cancelSearchPanelDragging,
        dispose: disposeSearchPanelDragging,
    } = useSearchPanelDragging({
        maximized: effectiveWindowMaximized,
        monitorHost: usesMonitorHost,
        prepareForNativeDrag,
        finishNativeDrag,
    });

    function handleSearchPanelDragStart() {
        beginSearchPanelInteraction();
    }

    function handleSearchPanelDragEnd() {
        endSearchPanelInteraction();
    }

    const logicalPanelResizeEnabled = computed(
        () => viewReady.value && usesMonitorHost.value && !effectiveWindowMaximized.value
    );
    const {
        startResizing: startSearchPanelResizing,
        cancelResizing: cancelSearchPanelResizing,
        dispose: disposeSearchPanelResizing,
    } = useSearchPanelResizing({
        panel: pageContainer,
        panelBounds,
        enabled: logicalPanelResizeEnabled,
        allowHeightOverride: allowLogicalPanelHeightResize,
        minimumSize: computed(() => ({
            width: searchWindowDefaultSize.value.width,
            height: searchWindowDefaultSize.value.height,
        })),
        beginResize: beginLogicalPanelResize,
        previewResize: previewLogicalPanelResize,
        commitResize: commitLogicalPanelResize,
        cancelResize: cancelLogicalPanelResize,
        onResizeStart: handleSearchPanelDragStart,
        onResizeEnd: handleSearchPanelDragEnd,
    });

    function handleSearchPanelResizeStart(
        direction: Parameters<typeof startSearchPanelResizing>[0],
        event: PointerEvent
    ) {
        void startSearchPanelResizing(direction, event).catch((error) => {
            log.error('[SearchView] Failed to resize logical search panel:', error);
        });
    }

    const { isQuickSearchOpen, shouldShowQuickSearch, shouldTriggerQuickSearch } =
        useQuickSearchCoordinator({
            queryText,
            attachments,
            sessionHistory,
            cursorContext,
            modelOverride,
            modelDropdownState,
            activeOverlay,
            quickSearchOpen,
            quickSearchHandoff,
            controller,
            suppressNextAutoOpen: suppressQuickSearchAutoOpenOnce,
            skillInputActive,
            fileInputActive,
            fileAutocompleteQuery,
        });
    const quickSearchEligible = computed(() => shouldShowQuickSearch(queryText.value));

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
        if (skillAutocompleteOpen.value || controller.hasInputContent()) return false;
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

    function getModelDropdownData(): ModelDropdownData {
        const context = controller.getModelDropdownContext();
        const models = filterModelDropdownItems(
            context.models
                .filter((model) => model.provider_enabled === 1)
                .map<ModelDropdownItem>((model) => ({
                    id: model.id,
                    modelId: model.model_id,
                    name: model.name,
                    providerId: model.provider_id,
                    providerName: model.provider_name,
                    reasoning: model.reasoning,
                    tool_call: model.tool_call,
                    modalities: model.modalities,
                    attachment: model.attachment,
                    open_weights: model.open_weights,
                })),
            modelDropdownQuery.value
        );
        return {
            activeModelId: context.activeModelId ?? '',
            activeProviderId: context.activeProviderId,
            selectedModelId: context.selectedModelId ?? '',
            selectedProviderId: context.selectedProviderId,
            searchQuery: modelDropdownQuery.value,
            toggleShortcut: searchKeybindings.value['search.model.toggle'],
            models,
        };
    }

    async function focusActiveOverlay(intentEpoch: number) {
        if (!isOverlayIntentCurrent(intentEpoch)) return;
        const overlayToFocus = activeOverlay.value;
        pendingOverlayFocus = overlayToFocus;
        pendingOverlayFocusEpoch = intentEpoch;
        await nextTick();
        if (!isOverlayIntentCurrent(intentEpoch) || activeOverlay.value !== overlayToFocus) {
            return;
        }
        await overlayHost.value?.refreshPosition();
    }

    function focusPendingOverlayWhenReady() {
        if (!overlayPositionReady.value) return;

        const overlayToFocus = pendingOverlayFocus;
        const focusEpoch = pendingOverlayFocusEpoch;
        if (
            overlayToFocus === 'none' ||
            overlayToFocus !== activeOverlay.value ||
            !isOverlayIntentCurrent(focusEpoch)
        ) {
            return;
        }

        const overlayHandle =
            overlayToFocus === 'model-dropdown'
                ? modelDropdownOverlay.value
                : sessionHistoryPopover.value;
        if (!overlayHandle) return;

        clearPendingOverlayFocus();
        overlayHandle.handleOverlayShown();
    }

    function handleOverlayPositioned(position: SearchOverlayPosition) {
        overlayRequiredViewportHeight.value = position.requiredViewportHeight;
        if (!overlayPositionReady.value && overlaySettleInFlightEpoch !== overlaySettleEpoch) {
            const settleEpoch = overlaySettleEpoch;
            const isCurrentOverlay = () =>
                settleEpoch === overlaySettleEpoch &&
                activeOverlay.value !== 'none' &&
                !searchViewListenersDisposed;
            overlaySettleInFlightEpoch = settleEpoch;
            void (async () => {
                try {
                    await remeasureTargetHeight();
                    if (!isCurrentOverlay()) return;
                    await nextTick();
                    if (!isCurrentOverlay()) return;

                    await overlayHost.value?.refreshPosition();
                    await nextTick();
                    if (!isCurrentOverlay() || !overlayFitsViewport()) return;
                    const regionsAccepted = await searchWindowRegionReporter.flush(
                        'overlay-reveal',
                        true
                    );
                    if (regionsAccepted && isCurrentOverlay() && overlayFitsViewport()) {
                        overlayPositionReady.value = true;
                        if (activeOverlay.value === 'session-history') {
                            beginHistoryInteraction();
                            reportHistoryInteractionOpened();
                        }
                    }
                } catch (error) {
                    log.error('[SearchView] Failed to settle positioned overlay bounds:', error);
                } finally {
                    if (overlaySettleInFlightEpoch === settleEpoch) {
                        overlaySettleInFlightEpoch = null;
                    }
                }
            })();
        } else if (overlayPositionReady.value) {
            void remeasureTargetHeight().catch((error) => {
                log.error('[SearchView] Failed to remeasure positioned overlay bounds:', error);
            });
        }
    }

    async function closeModelDropdownForIntent(intentEpoch: number, restoreFocus: boolean) {
        if (!isOverlayIntentCurrent(intentEpoch)) return false;
        clearPendingOverlayFocus();
        if (activeOverlay.value === 'model-dropdown') activeOverlay.value = 'none';
        modelDropdownState.value = { isOpen: false };
        modelDropdownQuery.value = '';
        if (restoreFocus) {
            await controller.focusSearchInput();
            if (!isOverlayIntentCurrent(intentEpoch)) return false;
        }
        return true;
    }

    async function closeModelDropdown(restoreFocus = true) {
        const intentEpoch = beginOverlayIntent();
        await closeModelDropdownForIntent(intentEpoch, restoreFocus);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
    }

    async function refreshModelDropdownData() {
        if (activeOverlay.value === 'model-dropdown') await overlayHost.value?.refreshPosition();
    }

    async function handleAiModelsUpdated() {
        controller.invalidateModelDropdownData();
        await controller.loadActiveModel();

        if (!modelDropdownState.value.isOpen) {
            return;
        }

        await controller.prefetchModelDropdownData();
        await refreshModelDropdownData();
    }

    async function handleSearchKeybindingAction(actionId: SearchKeybindingActionId) {
        switch (actionId) {
            case 'search.history.open':
                await openHistoryDialog();
                return;
            case 'search.input.focus':
                await hideAllOverlays();
                await controller.focusSearchInput();
                return;
            case 'search.session.new':
                await handleStartNewSession();
                return;
            case 'search.session.reopenLastClosed':
                await handleReopenLastClosedSession();
                return;
            case 'search.model.toggle':
                await handleToggleModelDropdownRequest();
                return;
            case 'search.quickSearch.toggleView':
                if (isQuickSearchOpen.value) {
                    controller.toggleQuickSearchView();
                }
                return;
            case 'search.window.pin':
                await handleToggleWindowPin();
                return;
            case 'search.window.maximize':
                await handleToggleMaximize();
                return;
            case 'search.settings.open':
                await native.window.openSettingsWindow();
                return;
            default: {
                const exhaustiveActionId: never = actionId;
                throw new Error(`Unhandled search keybinding action: ${exhaustiveActionId}`);
            }
        }
    }

    let routeSearchSurfaceCommand: ((payload: SearchSurfaceCommandEvent) => boolean) | null = null;

    const {
        hideSearchWindow: hideSearchWindowBase,
        handleSearchSurfaceShown,
        handleSearchSurfaceHidden,
    } = useSearchPageLifecycle({
        controller,
        viewReady,
        isDragging,
        isPinned,
        isMaximized: effectiveWindowMaximized,
        searchKeybindings,
        isSurfaceTransitioning: isSessionExpandAnimating,
        interactionContext: searchInteractionContext,
        syncWindowPinState,
        clearSession: clearSessionToIdle,
        shouldClearSessionAfterTimeout,
        reconcileSearchOverlays: hideAllOverlays,
        remeasureSearchWindowHeight: remeasureTargetHeight,
        onSurfaceVisibilityChange: (visible) => {
            setWindowVisible(visible);
            surfaceHiding.value = !visible;
            if (visible) handleHostViewportChange();
        },
        onSurfaceHidden: clearSurfaceUiAfterHidden,
        handleSearchSurfaceCommand: (payload) => {
            routeSearchSurfaceCommand?.(payload);
        },
        handleSessionStatusReminderAction,
        handleAiModelsUpdated,
        handleShortcutAutoPaste: tryShortcutAutoPaste,
    });
    const searchHostWindow = getCurrentWindow();
    const searchSurfacePreparationController = createSearchSurfacePreparationController({
        listenPrepare: (handler) => eventService.on(AppEvent.SEARCH_SURFACE_PREPARE, handler),
        listenShown: (handler) => eventService.on(AppEvent.SEARCH_SURFACE_SHOWN, handler),
        listenHidden: (handler) => eventService.on(AppEvent.SEARCH_SURFACE_HIDDEN, handler),
        getRendererEpoch: () => native.window.getSearchWindowRendererEpoch(),
        markRendererReady: (rendererEpoch) => native.window.markSearchWindowReady(rendererEpoch),
        getViewport: async () => {
            const [position, size, scaleFactor] = await Promise.all([
                searchHostWindow.outerPosition(),
                searchHostWindow.innerSize(),
                searchHostWindow.scaleFactor(),
            ]);
            return {
                physicalViewport: {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                },
                scaleFactor,
            };
        },
        settle: settleSearchSurfaceViewport,
        flush: (preparation) =>
            searchWindowRegionReporter.flush('surface-preparation', true, preparation),
        onShown: handleSearchSurfaceShown,
        onHidden: handleSearchSurfaceHidden,
        onError: (error) => {
            const surface = pageContainer.value?.getBoundingClientRect();
            const card = searchViewCard.value?.getBoundingClientRect();
            log.error('[SearchView] Failed to commit search surface preparation:', error, {
                ready: viewReady.value,
                contentReady: searchViewContentReady.value,
                monitorHost: usesMonitorHost.value,
                viewportWidth: innerWidth,
                viewportHeight: innerHeight,
                scale: devicePixelRatio,
                surfaceWidth: surface?.width ?? 0,
                surfaceHeight: surface?.height ?? 0,
                cardWidth: card?.width ?? 0,
                cardHeight: card?.height ?? 0,
            });
            void native.window.hideSearchWindow().catch((hideError) => {
                log.error('[SearchView] Failed to hide unsafe prepared surface:', hideError);
            });
        },
    });
    notifySearchSurfaceViewportChanged = searchSurfacePreparationController.notifyViewportChanged;

    async function hideSearchWindow() {
        surfaceHiding.value = true;
        cancelSessionExpansion();
        beginOverlayIntent();
        clearPendingOverlayFocus();
        try {
            await hideSearchWindowBase();
        } catch (error) {
            surfaceHiding.value = false;
            throw error;
        }
    }

    function getSessionHistoryOverlayData(): SessionHistoryData {
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
            toggleShortcut: searchKeybindings.value['search.history.open'],
        };
    }

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

    /**
     * Height of the results row the handoff is folding away.
     *
     * The row stays in the layout while it collapses so the editor can ride down as the
     * conversation grows, which means the measurement sees the results on top of the
     * conversation. Their own height has to come back off the total.
     */
    function collapsingQuickSearchHeight() {
        const shell = quickSearchHandoffShell.value;
        if (!shell || !quickSearchHandoff.value) return 0;
        return shell.getBoundingClientRect().height;
    }

    function measurePageContentHeight(content: HTMLElement) {
        if (!conversationPanel.value || !conversationContainer.value) {
            const picker = skillAutocompleteOpen.value
                ? skillPickerPanel.value
                : quickSearchOpen.value
                  ? quickSearchPanel.value
                  : undefined;
            const editor = inputArea.value?.firstElementChild;
            if (picker && editor) {
                // Measure requested results independently of the animated viewport.
                return editor.getBoundingClientRect().height + picker.getContentHeight();
            }
            return Math.max(content.scrollHeight, content.getBoundingClientRect().height);
        }

        const controlsHeight = Array.from(content.children).reduce((height, child) => {
            if (!(child instanceof HTMLElement) || child === conversationContainer.value) {
                return height;
            }
            return height + child.getBoundingClientRect().height;
        }, 0);
        return (
            conversationPanel.value.getContentHeight() +
            controlsHeight -
            collapsingQuickSearchHeight()
        );
    }

    function cancelSessionExpansion() {
        sessionExpansion?.abort();
        sessionExpansion = null;
        surfaceMeasurementHold.value = false;
        closeOverlayImmediately.value = false;
        quickSearchHandoffClosePromise = null;
        if (quickSearchHandoff.value) {
            quickSearchPanel.value?.close();
            finalizeQuickSearchClose();
            quickSearchHandoffLifecycle.dispatch('finish');
        }
    }

    function beginSessionExpansion() {
        cancelSessionExpansion();
        const expansion = new AbortController();
        sessionExpansion = expansion;
        surfaceMeasurementHold.value = true;
        return expansion;
    }

    async function waitForSessionExpandContentHeight(
        request: Promise<unknown>,
        signal: AbortSignal
    ) {
        await nextTick();
        if (signal.aborted) return null;
        return new Promise<number | null>((resolve) => {
            let settled = false;
            const finish = (height: number | null) => {
                if (settled) return;
                settled = true;
                stop();
                signal.removeEventListener('abort', cancel);
                resolve(height);
            };
            const cancel = () => finish(null);
            const measure = () => {
                if (settled) return;
                if (conversationPanel.value && sessionHistory.value.length > 0) {
                    const height = measureTargetHeight();
                    if (height !== null) finish(height);
                }
            };
            const stop = watch([conversationPanel, searchViewContentReady], measure, {
                flush: 'post',
            });
            signal.addEventListener('abort', cancel, { once: true });
            measure();
            // A rejected, cancelled or empty submission has no content to wait for.
            void request.then(async () => {
                await nextTick();
                measure();
                finish(null);
            }, cancel);
        });
    }

    async function startQuickSearchHandoffClose(signal: AbortSignal) {
        if (signal.aborted || !quickSearchHandoff.value || quickSearchHandoffClosing.value) return;
        quickSearchHandoffLifecycle.dispatch('close');
        // Freeze measurement for the fold. The results row keeps its place while it
        // collapses and the conversation grows into the space it gives up, so the
        // live height loop would otherwise chase both.
        foldQuickSearchRevealIntoHandoff();
        await nextTick();
        if (signal.aborted) return;
        const animations = quickSearchHandoffShell.value?.getAnimations?.() ?? [];
        const cancel = () => animations.forEach((animation) => animation.cancel());
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        quickSearchHandoffClosePromise = Promise.allSettled(
            animations.map((animation) => animation.finished)
        ).then(() => signal.removeEventListener('abort', cancel));
    }

    async function finishQuickSearchHandoff(signal: AbortSignal) {
        if (!quickSearchHandoff.value) return;
        await quickSearchHandoffClosePromise;
        if (signal.aborted) return;
        quickSearchHandoffClosePromise = null;
        quickSearchPanel.value?.close();
        finalizeQuickSearchClose();
        await nextTick();
        if (signal.aborted) return;
        quickSearchHandoffLifecycle.dispatch('finish');
    }

    async function submitSearchQuery(
        ...args: Parameters<typeof handleSubmit>
    ): ReturnType<typeof handleSubmit> {
        const quickSearchWasOpen = quickSearchOpen.value;
        const shouldExpand = sessionHistory.value.length === 0 && !effectiveWindowMaximized.value;
        const expansion = shouldExpand || quickSearchWasOpen ? beginSessionExpansion() : null;

        if (quickSearchWasOpen) {
            quickSearchHandoffLifecycle.dispatch('begin');
        }
        try {
            if (shouldExpand) {
                await hideAllOverlays(false);
            }

            const submitPromise = handleSubmit(...args);
            if (expansion?.signal.aborted) return submitPromise;
            if (quickSearchWasOpen) {
                // Hand the viewport over: the results row collapses on the card's curve
                // while the conversation grows into the space it gives up.
                await startQuickSearchHandoffClose(expansion!.signal);
            }
            if (!shouldExpand) {
                return submitPromise;
            }

            const contentHeight = await waitForSessionExpandContentHeight(
                submitPromise,
                expansion!.signal
            );
            if (expansion!.signal.aborted) return submitPromise;
            if (contentHeight === null) {
                if (sessionHistory.value.length === 0) {
                    await resetSearchWindowBounds().catch((error) => {
                        log.error(
                            '[SearchView] Failed to restore idle bounds after empty submission:',
                            error
                        );
                    });
                }
                return submitPromise;
            }

            await playSessionExpandAnimation(contentHeight).catch((error) => {
                log.error('[SearchView] Failed to animate session expand after submit:', error);
            });
            if (expansion!.signal.aborted) return submitPromise;
            scheduleSearchWindowRegionSync(true, true);

            return submitPromise;
        } finally {
            if (expansion === sessionExpansion && quickSearchWasOpen && quickSearchHandoff.value) {
                await startQuickSearchHandoffClose(expansion!.signal);
                await finishQuickSearchHandoff(expansion!.signal);
            }
            if (expansion === sessionExpansion) {
                surfaceMeasurementHold.value = false;
                sessionExpansion = null;
            }
        }
    }

    const completeFile = computed(() => {
        if (
            !quickSearchOpen.value ||
            quickSearchRevealPhase.value === 'folding' ||
            quickSearchHandoff.value ||
            !fileSearchEnabled.value ||
            activeOverlay.value !== 'none' ||
            (attachments.value.length && fileAutocompleteQuery.value === null)
        )
            return undefined;
        return (index?: number) => {
            const item = quickSearchPanel.value?.getReferenceCandidate(
                index,
                fileAutocompleteQuery.value ?? queryText.value
            );
            if (!item) return null;
            const attachment = createAttachmentFromSearchResult(item);
            attachments.value.push(attachment);
            return attachment;
        };
    });

    const searchKeyboard = useSearchKeyboard({
        cancelActivePanelInteraction: () => {
            const resizeCancelled = cancelSearchPanelResizing();
            const dragCancelled = cancelSearchPanelDragging();
            return resizeCancelled || dragCancelled;
        },
        viewReady,
        searchKeybindings,
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
        getActiveOverlaySurface: () =>
            activeOverlay.value === 'model-dropdown'
                ? 'model-dropdown-surface'
                : activeOverlay.value === 'session-history'
                  ? 'session-history-surface'
                  : null,
        forwardOverlayKeydown: (key) => {
            const event = new KeyboardEvent('keydown', { key });
            if (activeOverlay.value === 'model-dropdown')
                modelDropdownOverlay.value?.handleKeyDown(event);
            if (activeOverlay.value === 'session-history')
                sessionHistoryPopover.value?.handleKeyDown(event);
        },
        isQuickSearchOpen,
        shouldTriggerQuickSearch,
        sessionHistoryOverlayOpen,
        hideAllOverlays,
        hideSearchWindow,
        navigateInputHistory,
        closeModelDropdown,
        toggleWindowMaximize: handleToggleMaximize,
        handleSearchKeybindingAction,
        handleSubmit: submitSearchQuery,
        clearAll,
        cancelRequest,
        clearSession: clearSessionToIdle,
        clearDraft: () => clearDraft({ preserveModelTag: true }),
    });
    routeSearchSurfaceCommand = searchKeyboard.routeSearchSurfaceCommand;

    function handleQueryTextChange(value: string) {
        queryText.value = value;
    }

    function handleSkillInputActiveChange(active: boolean) {
        skillInputActive.value = active;
        if (active && fileAutocompleteQuery.value === null && !quickSearchHandoff.value) {
            finalizeQuickSearchClose();
        }
    }

    function handleSkillAutocompleteOpenChange(open: boolean) {
        skillAutocompleteOpen.value = open;
        if (open && (pendingModelOpenEpoch !== null || activeOverlay.value !== 'none')) {
            void hideAllOverlays(false).catch((error) => {
                log.error('[SearchView] Failed to dismiss overlays before skill selection:', error);
            });
        }
    }

    function handleFileAutocompleteQueryChange(query: string | null) {
        fileAutocompleteQuery.value = query;
        if (query !== null && (pendingModelOpenEpoch !== null || activeOverlay.value !== 'none')) {
            void hideAllOverlays(false).catch((error) =>
                log.error('[SearchView] Failed to dismiss overlays before file selection:', error)
            );
        }
    }

    function handleFileReference(index: number) {
        searchBar.value?.completeFileReference?.(index);
    }

    function moveFileSelection(direction: 'up' | 'down' | 'left' | 'right') {
        return quickSearchPanel.value?.moveSelection(direction) ?? false;
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

    function finalizeQuickSearchClose() {
        quickSearchRevealEpoch += 1;
        quickSearchRevealPhase.value = 'idle';
        quickSearchOpen.value = false;
    }

    function beginQuickSearchClose() {
        if (!quickSearchOpen.value || quickSearchRevealPhase.value === 'folding') return;
        quickSearchRevealEpoch += 1;
        // Keep the result list painted at full height and let the card fold it away: the
        // shrinking card edge is the transition, so the list can never fade out first and
        // leave an empty expanded card behind.
        quickSearchRevealPhase.value = 'folding';
        const closeEpoch = quickSearchRevealEpoch;
        const shouldRestoreIdleHost =
            sessionHistory.value.length === 0 && !effectiveWindowMaximized.value;
        const finish = () => {
            if (closeEpoch !== quickSearchRevealEpoch || searchViewListenersDisposed) {
                return;
            }
            // A session handoff owns its final close so the session transition can use
            // the same reverse shell without a second close path.
            if (quickSearchHandoff.value && quickSearchHandoffClosing.value) return;
            void finalizeQuickSearchClose();
        };

        if (shouldRestoreIdleHost) {
            void collapseBeforeClearing(
                () => closeEpoch === quickSearchRevealEpoch && !searchViewListenersDisposed
            )
                .then((collapsed) => {
                    if (closeEpoch !== quickSearchRevealEpoch || searchViewListenersDisposed)
                        return;
                    if (collapsed) finish();
                    else quickSearchRevealPhase.value = 'open';
                })
                .catch((error) => log.error('[SearchView] Failed to fold QuickSearch:', error));
            return;
        }

        // A conversation owns the height: the card keeps it and only the result row folds
        // away, so the content measurement shrinks the surface by exactly that row.
        quickSearchRevealPhase.value = 'handoff';
        void nextTick()
            .then(() =>
                Promise.allSettled(
                    (quickSearchHandoffShell.value?.getAnimations?.() ?? []).map(
                        (animation) => animation.finished
                    )
                )
            )
            .then(finish);
    }

    /**
     * Hand the QuickSearch viewport over to a submitted conversation.
     *
     * The list is taken out of the layout in the same frame (so it cannot add its height to
     * the measured content) but stays painted while it slides out, so the conversation rises
     * underneath it instead of the whole surface jumping.
     */
    function foldQuickSearchRevealIntoHandoff() {
        if (!quickSearchOpen.value) return;
        quickSearchRevealEpoch += 1;
        quickSearchRevealPhase.value = 'handoff';
    }

    function handleQuickSearchOpenChange(value: boolean) {
        if (!fileSearchEnabled.value && !quickSearchHandoff.value) {
            finalizeQuickSearchClose();
            return;
        }
        if (value && !quickSearchEligible.value) return;
        // A stale QuickSearch request can finish after submission has started.
        // Keep the panel mounted until the handoff animation owns the close.
        if (!value && quickSearchHandoff.value && !quickSearchHandoffClosing.value) {
            return;
        }

        if (!value) {
            // The handoff calls QuickSearch.close() after its reverse transition;
            // it only emits this notification to the parent and must not restart
            // the timer or remove the shell early.
            if (quickSearchHandoff.value && quickSearchHandoffClosing.value) return;
            beginQuickSearchClose();
            return;
        }

        // Search results refresh the existing panel by emitting `true` again.
        // That is a data update, not a new reveal, so do not reset the CSS start
        // state and flash the panel on every keystroke.
        if (quickSearchOpen.value && quickSearchRevealPhase.value !== 'folding') {
            return;
        }

        quickSearchRevealEpoch += 1;
        // Measure the hidden list before revealing it to avoid an empty expanded frame.
        quickSearchRevealPhase.value = 'measuring';
        quickSearchOpen.value = true;
        void nextTick().then(() => settleQuickSearchReveal());
    }

    function settleQuickSearchReveal() {
        if (!quickSearchRevealPending.value || searchViewListenersDisposed) {
            return;
        }

        // Results are assigned before the open signal; nextTick commits their DOM.
        // The geometry owner measures once and reserves the region before animating.
        quickSearchRevealPhase.value = 'open';
        void remeasureTargetHeight().catch((error) => {
            log.error('[SearchView] Failed to measure QuickSearch reveal:', error);
        });
    }

    async function handlePinChange(value: boolean) {
        try {
            await setWindowPinned(value);
            scheduleSearchWindowRegionSync(true, true);
        } catch (error) {
            log.error('[SearchView] Failed to update window pin state:', error);
            await notify({
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

        const payload = await clipboardService.readExplicitPastePayload(event.clipboardData);
        if (!payload) return;

        const hasOnlyText =
            !clipboardPayloadHasAttachmentFragments(payload) &&
            !payload.imagePaths?.length &&
            !payload.filePaths?.length;

        if (hasOnlyText && payload.text) {
            const trimmedText = trimClipboardPayloadTextBoundary(payload).text;
            if (trimmedText?.trim()) {
                searchBar.value?.insertTextAtCursor(trimmedText);
            }
            return;
        }

        if (clipboardPayloadHasAttachmentFragments(payload)) {
            await insertClipboardPayloadAtCursor(payload);
            return;
        }

        if (payload.text?.trim()) {
            searchBar.value?.insertTextAtCursor(payload.text);
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
                log.error(`Failed to insert ${type} attachment:`, error);
            }
        }
    }

    async function insertClipboardPayloadAtCursor(payload: ClipboardPayload) {
        const normalizedPayload = trimClipboardPayloadTextBoundary(payload);
        if (!normalizedPayload.fragments?.length) {
            return;
        }

        for (const fragment of normalizedPayload.fragments) {
            if (fragment.type === 'text') {
                if (fragment.text) {
                    searchBar.value?.insertTextAtCursor(fragment.text);
                }
                continue;
            }

            try {
                const attachment = await createAttachmentFromClipboardPath(
                    fragment.type,
                    fragment.path
                );
                attachments.value.push(attachment);
                searchBar.value?.insertAttachmentAtCursor(
                    attachment.id,
                    attachment.name ||
                        t(
                            fragment.type === 'image'
                                ? 'conversation.attachment.unnamedImage'
                                : 'conversation.attachment.unnamedFile'
                        ),
                    fragment.type,
                    attachment.preview
                );
            } catch (error) {
                log.error(`Failed to insert ${fragment.type} attachment:`, error);
            }
        }
    }

    /**
     * 鍦ㄥ揩鎹烽敭鍞よ捣绐楀彛鍚庡皾璇?auto-paste銆?     */
    async function tryShortcutAutoPaste(isCurrent = () => true) {
        const visibilityEpoch = searchInteractionContext.state.visibilityEpoch;
        const isEntryCurrent = () =>
            isCurrent() &&
            searchInteractionContext.state.windowVisible &&
            searchInteractionContext.state.visibilityEpoch === visibilityEpoch;

        if (!isEntryCurrent()) {
            return;
        }

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
            if (!isEntryCurrent() || !payload) {
                return;
            }

            if (!isEntryCurrent() || !searchEntryPolicy.shouldConsumeSnapshot(payload.snapshotId)) {
                return;
            }

            if (!isEntryCurrent()) {
                return;
            }
            searchEntryPolicy.markSnapshotConsumed(payload.snapshotId);

            if (!isEntryCurrent()) {
                return;
            }
            await importClipboardPayload(payload, { trimTextBoundary: true });
        } finally {
            if (isEntryCurrent()) {
                searchInteractionContext.markEntryChecked(visibilityEpoch);
            }
        }
    }

    async function closeSessionHistoryOverlayForIntent(intentEpoch: number, restoreFocus: boolean) {
        if (!isOverlayIntentCurrent(intentEpoch)) return false;
        clearPendingOverlayFocus();
        if (activeOverlay.value === 'session-history') activeOverlay.value = 'none';
        await setSessionHistoryOverlayOpen(false);
        if (!isOverlayIntentCurrent(intentEpoch)) return false;
        if (restoreFocus) {
            await controller.focusSearchInput();
            if (!isOverlayIntentCurrent(intentEpoch)) return false;
        }
        return true;
    }

    async function closeSessionHistoryOverlay(restoreFocus = true) {
        const intentEpoch = beginOverlayIntent();
        await closeSessionHistoryOverlayForIntent(intentEpoch, restoreFocus);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
    }

    async function hideAllOverlaysForIntent(intentEpoch: number, restoreFocus: boolean) {
        if (!isOverlayIntentCurrent(intentEpoch)) return false;
        const hadOverlay = activeOverlay.value !== 'none';
        clearPendingOverlayFocus();
        activeOverlay.value = 'none';
        modelDropdownState.value = { isOpen: false };
        modelDropdownQuery.value = '';
        await setSessionHistoryOverlayOpen(false);
        if (!isOverlayIntentCurrent(intentEpoch)) return false;
        if (restoreFocus && hadOverlay) {
            await controller.focusSearchInput();
            if (!isOverlayIntentCurrent(intentEpoch)) return false;
        }
        return true;
    }

    async function hideAllOverlays(restoreFocus = true) {
        const intentEpoch = beginOverlayIntent();
        await hideAllOverlaysForIntent(intentEpoch, restoreFocus);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
    }

    async function clearSurfaceUiAfterHidden() {
        surfaceHiding.value = true;
        cancelSessionExpansion();
        overlaySettleEpoch += 1;
        overlayPositionReady.value = false;
        const intentEpoch = beginOverlayIntent();
        cancelSearchPanelResizing();
        cancelSearchPanelDragging();
        await hideAllOverlaysForIntent(intentEpoch, false);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
        renderedOverlay.value = 'none';
        overlayAnchorElement.value = null;
        overlayPositionAnchorElement.value = null;
        overlayRegionElement.value = null;
    }

    function clearPendingModelOpen(intentEpoch: number) {
        if (pendingModelOpenEpoch === intentEpoch) pendingModelOpenEpoch = null;
    }

    async function handleToggleModelDropdownRequest() {
        if (surfaceHiding.value || searchViewListenersDisposed) return;
        if (pendingModelOpenEpoch !== null) {
            // A second toggle while the model data is still loading means
            // "cancel the pending open". Invalidate the first intent without
            // starting another asynchronous load.
            beginOverlayIntent();
            return;
        }

        const intentEpoch = beginOverlayIntent();
        if (activeOverlay.value === 'model-dropdown') {
            await closeModelDropdownForIntent(intentEpoch, true);
            if (!isOverlayIntentCurrent(intentEpoch)) return;
            return;
        }

        pendingModelOpenEpoch = intentEpoch;
        try {
            // The picker layers over the results list instead of dismissing it: the list is what the
            // user was reading, and collapsing it to show a popup makes the surface collapse and grow
            // again for something that only hangs above it.
            await closeSessionHistoryOverlayForIntent(intentEpoch, false);
            if (!isOverlayIntentCurrent(intentEpoch)) return;
            if (!(await closeSkillPickerForOverlayIntent(intentEpoch))) return;
            await controller.prepareModelDropdownOpen(() => isOverlayIntentCurrent(intentEpoch));
            if (!isOverlayIntentCurrent(intentEpoch)) return;
            overlayAnchorElement.value = controller.getModelDropdownAnchor();
            // The picker belongs to the editor row, including its padding, in every surface mode.
            overlayPositionAnchorElement.value =
                overlayAnchorElement.value?.closest<HTMLElement>('[data-testid="search-bar"]') ??
                pageContent.value ??
                overlayAnchorElement.value;
            if (quickSearchOpen.value) {
                // A popup opened over the results list covers it: the slot's left edge is the surface's and
                // its top edge is the list's first row, which is the search box's bottom.
                alignOverlayToResultsSlot(true);
                overlayPositionAnchorElement.value =
                    overlayLeftAlignElement.value ??
                    document.querySelector<HTMLElement>("[data-testid='search-bar']") ??
                    overlayPositionAnchorElement.value;
            } else {
                alignOverlayToResultsSlot(false);
            }
            if (!overlayAnchorElement.value || !overlayPositionAnchorElement.value) {
                return;
            }
            modelDropdownState.value = { isOpen: true };
            renderedOverlay.value = 'model-dropdown';
            overlayPositionReady.value = false;
            overlaySettleEpoch += 1;
            activeOverlay.value = 'model-dropdown';
            clearPendingModelOpen(intentEpoch);
            await focusActiveOverlay(intentEpoch);
            if (!isOverlayIntentCurrent(intentEpoch)) return;
        } finally {
            clearPendingModelOpen(intentEpoch);
        }
    }

    async function openHistoryDialog() {
        if (surfaceHiding.value || searchViewListenersDisposed) return;
        const intentEpoch = beginOverlayIntent();
        if (activeOverlay.value === 'session-history') {
            await closeSessionHistoryOverlayForIntent(intentEpoch, true);
            if (!isOverlayIntentCurrent(intentEpoch)) return;
            return;
        }
        // The overlay opens below its anchor, so the anchor must be a content-sized
        // node. pageContainer stretches with the native host, which would feed the
        // surface's own growth back into the overlay envelope forever.
        const anchorElement =
            sessionHistory.value.length > 0
                ? (conversationPanel.value?.getHistoryAnchor() ?? null)
                : (pageContent.value ?? pageContainer.value);
        if (!anchorElement) return;
        await handleHistoryOpenChangeForIntent({ open: true, anchorElement }, intentEpoch);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
    }

    async function closeSkillPickerForOverlayIntent(intentEpoch: number) {
        if (!isOverlayIntentCurrent(intentEpoch)) return false;
        if (!controller.isSkillAutocompleteOpen()) return true;
        controller.closeSkillAutocomplete();
        await nextTick();
        if (!isOverlayIntentCurrent(intentEpoch)) return false;
        try {
            await remeasureTargetHeight();
        } catch (error) {
            log.error('[SearchView] Failed to settle skill picker before opening overlay:', error);
            return false;
        }
        return isOverlayIntentCurrent(intentEpoch);
    }

    async function handleHistoryOpenChangeForIntent(
        payload: {
            open: boolean;
            anchorElement: HTMLElement | null;
        },
        intentEpoch: number
    ) {
        if (!isOverlayIntentCurrent(intentEpoch) || (payload.open && surfaceHiding.value)) return;
        if (!payload.open) {
            await closeSessionHistoryOverlayForIntent(intentEpoch, true);
            if (!isOverlayIntentCurrent(intentEpoch)) return;
            return;
        }
        // Layered over the results list, like the model picker: opening a popup must not dismiss
        // what the user was reading.
        await closeModelDropdownForIntent(intentEpoch, false);
        if (!(await closeSkillPickerForOverlayIntent(intentEpoch))) return;
        // The same rule as the model picker: while the list is open the popup covers it, so it needs
        // the slot's edges and none of its own control's placement.
        if (quickSearchOpen.value) {
            alignOverlayToResultsSlot(true);
        } else {
            alignOverlayToResultsSlot(false);
        }
        if (!isOverlayIntentCurrent(intentEpoch)) return;
        overlayAnchorElement.value = payload.anchorElement;
        overlayPositionAnchorElement.value = overlayFloatsOverResults.value
            ? overlayLeftAlignElement.value
            : payload.anchorElement;
        if (!overlayAnchorElement.value) return;
        const historyStateUpdate = setSessionHistoryOverlayOpen(true);
        renderedOverlay.value = 'session-history';
        overlayPositionReady.value = false;
        overlaySettleEpoch += 1;
        activeOverlay.value = 'session-history';
        await historyStateUpdate;
        if (!isOverlayIntentCurrent(intentEpoch)) return;
        await focusActiveOverlay(intentEpoch);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
        void ensureSessionListLoaded().catch((error) => {
            log.error('[SearchView] Failed to ensure session history before interaction:', error);
        });
    }

    async function handleHistoryOpenChange(payload: {
        open: boolean;
        anchorElement: HTMLElement | null;
    }) {
        const intentEpoch = beginOverlayIntent();
        await handleHistoryOpenChangeForIntent(payload, intentEpoch);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
    }

    function handleHistoryPrefetch() {
        if (sessionHistoryOverlayOpen.value) {
            return;
        }

        void ensureSessionListLoaded().catch((error) => {
            log.error('[SearchView] Failed to prefetch session history:', error);
        });
    }

    function handleModelDropdownPrefetch() {
        if (modelDropdownState.value.isOpen) {
            return;
        }

        void controller.prefetchModelDropdownData().catch((error) => {
            log.error('[SearchView] Failed to refresh model dropdown data on hover:', error);
        });
    }

    function handleOverlayOutsideClick(event: PointerEvent) {
        // A model-menu outside gesture is a dismissal gesture. Consume the
        // initiating pointer event so the underlying trigger cannot receive a
        // synthetic click after the overlay closes. History intentionally
        // keeps the legacy dismiss-and-continue behaviour.
        if (renderedOverlay.value === 'model-dropdown') {
            event.preventDefault();
            event.stopPropagation();
        }
        void hideAllOverlays();
    }

    async function handleModelSelect(modelDbId: number) {
        const intentEpoch = beginOverlayIntent();
        const selectedModel = await controller.selectModelFromDropdown(modelDbId);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
        modelOverride.value = selectedModel;
        await closeModelDropdownForIntent(intentEpoch, true);
        if (!isOverlayIntentCurrent(intentEpoch)) return;
    }

    function handleModelSearchQueryChange(value: string) {
        modelDropdownQuery.value = value;
        void nextTick().then(() => overlayHost.value?.refreshPosition());
    }

    async function handleSessionSearchQueryChange(value: string) {
        await updateSessionSearchQuery(value);
    }

    async function collapseBeforeClearing(isCurrent = () => !searchViewListenersDisposed) {
        if (effectiveWindowMaximized.value) return true;
        try {
            const collapsed = await collapseSessionToIdle();
            if (!isCurrent()) return false;
            if (collapsed) return true;
            return (await resetSearchWindowBounds()) && isCurrent();
        } catch (error) {
            log.error('[SearchView] Failed to restore compact bounds:', error);
            return false;
        }
    }

    async function clearSessionToIdle() {
        cancelSessionExpansion();
        suppressQuickSearchAutoOpenOnce.value = true;
        if (!(await collapseBeforeClearing())) return;
        clearSession();
        await nextTick();
        await controller.focusSearchInput();
    }

    async function handleStartNewSession() {
        cancelSessionExpansion();
        if (sessionHistory.value.length === 0) {
            return;
        }

        controller.closeQuickSearch();
        await hideAllOverlays();
        if (!(await collapseBeforeClearing())) return;
        startNewSession();
        resetSessionInputHistoryTracking();
        await nextTick();
        await controller.focusSearchInput();
    }

    async function handleReopenLastClosedSession() {
        cancelSessionExpansion();
        if (queryText.value.trim() || attachments.value.length > 0) {
            await hideAllOverlays();
            await controller.focusSearchInput();
            return;
        }

        controller.closeQuickSearch();
        await hideAllOverlays();
        resetSessionInputHistoryTracking();

        try {
            const reopenedSession = await reopenLastClosedSession();
            if (!reopenedSession) {
                await controller.focusSearchInput();
                return;
            }

            await syncSearchWindowState().catch((error) => {
                log.error(
                    '[SearchView] Failed to sync search window state after reopening session:',
                    error
                );
            });
            await remeasureTargetHeight().catch((error) => {
                log.error(
                    '[SearchView] Failed to remeasure window height after reopening session:',
                    error
                );
            });
            conversationPanel.value?.revealLatestContent();
        } catch (error) {
            log.error('[SearchView] Failed to reopen last closed session:', error);
            await controller.focusSearchInput();
        }
    }

    async function handleToggleWindowPin() {
        try {
            await toggleWindowPin();
            scheduleSearchWindowRegionSync(true, true);
        } catch (error) {
            log.error('[SearchView] Failed to toggle window pin state:', error);
            await notify({
                title: t('notification.pinToggleFailed.title'),
                body: t('notification.pinToggleFailed.body'),
            });
        }
    }

    async function handleToggleMaximize() {
        try {
            await hideAllOverlays();
            await toggleMaximizeBase();
        } catch (error) {
            log.error('[SearchView] Failed to toggle maximized state:', error);
        }
    }

    async function handleOpenSession(sessionId: number, origin: 'history' | 'other' = 'other') {
        const expansion = beginSessionExpansion();
        // The history popup closes before the session opens, so keep that
        // specific interaction's handle alive until its selection event is
        // recorded. Notification/navigation opens are not history selections.
        const selection = origin === 'history' ? markHistorySelectionPending() : null;
        controller.closeQuickSearch();
        try {
            closeOverlayImmediately.value = true;
            await hideAllOverlays(false);
            // Session content must be measured without the closing history region
            // contributing its old bottom edge to the bounded native host.
            await nextTick();
        } catch (error) {
            if (origin === 'history') {
                // The selection never reached the real open path; settle and
                // release the history interaction instead of leaking its handle.
                abandonHistorySelection(selection);
            }
            if (sessionExpansion === expansion) cancelSessionExpansion();
            throw error;
        }
        resetSessionInputHistoryTracking();
        if (expansion.signal.aborted) {
            abandonHistorySelection(selection);
            return;
        }
        try {
            // Keep the native host put until the opened session has a measured
            // height. The visible card then grows in CSS inside that frame.
            await openSession(sessionId, origin, selection);
            await nextTick();
            if (expansion.signal.aborted) return;
            const contentHeight = sessionHistory.value.length > 0 ? measureTargetHeight() : null;
            await playSessionExpandAnimation(contentHeight ?? undefined).catch((error) => {
                log.error('[SearchView] Failed to animate session expand:', error);
            });
            if (expansion.signal.aborted) return;
            await settleSearchSurfaceViewport();
            if (expansion.signal.aborted) return;
            // playSessionExpandAnimation already commits the measured target
            // height. A second synchronous native resize here used to move the
            // window again after the CSS reveal had finished; let the observers
            // handle any later message/image growth instead.
            scheduleSearchWindowRegionSync(true, true);
            conversationPanel.value?.revealLatestContent();
        } catch (error) {
            if (expansion.signal.aborted) return;
            log.error('[SearchView] Failed to open session:', error);

            const isMissingSession =
                error instanceof Error && /not found|不存在/i.test(error.message);

            if (isMissingSession) {
                void refreshSessionList().catch((refreshError) => {
                    log.error(
                        '[SearchView] Failed to refresh session history after open failure:',
                        refreshError
                    );
                });
            }

            await resetSearchWindowBounds().catch((resetError) => {
                log.error(
                    '[SearchView] Failed to restore idle bounds after session open failure:',
                    resetError
                );
            });

            await notify({
                title: t('notification.openSessionFailed.title'),
                body: t(
                    isMissingSession
                        ? 'notification.openSessionFailed.missing'
                        : 'notification.openSessionFailed.generic'
                ),
            });

            await controller.focusSearchInput();
        } finally {
            if (sessionExpansion === expansion) {
                sessionExpansion = null;
                surfaceMeasurementHold.value = false;
                closeOverlayImmediately.value = false;
            }
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
        await submitSearchQuery(normalizedReply, replySnapshot);
    }

    async function handleSessionStatusReminderAction(payload: SessionStatusReminderActionEvent) {
        controller.closeQuickSearch();
        await hideAllOverlays();

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

    // Fixtures come from the test runner so production holds no synthetic search results.
    const e2eSearchFixture = ref<{ query: string; results: QuickShortcutItem[] } | null>(null);

    async function installE2eBridge() {
        if (searchViewListenersDisposed || !(await isE2eTestMode())) {
            return;
        }
        if (searchViewListenersDisposed) {
            return;
        }

        widgetBridgeWindow.__TOUCHAI_E2E__ = {
            async openSettingsWindow() {
                await native.window.openSettingsWindow();
            },
            setSearchQuery(text: string) {
                applyE2eSearchQuery(text);
            },
            resetDraft() {
                clearDraft();
            },
            async sendPrompt(text: string) {
                const snapshot = createInputHistorySnapshot({
                    text,
                    attachments: [],
                    excludeFromHistory: true,
                });
                applyE2eSearchQuery(text);
                await submitSearchQuery(text, snapshot);
            },
            getQuickSearchFallbackResults(query: string) {
                const fixture = e2eSearchFixture.value;
                return fixture?.query.trim().toLowerCase() === query.trim().toLowerCase()
                    ? fixture.results.map((item) => ({ ...item }))
                    : [];
            },
            getSearchWindowState: native.window.getSearchWindowState,
            resizeWindowHeight: native.window.resizeWindowHeight,
            resetSearchWindowBounds: native.window.resetSearchWindowBounds,
            setSearchFixture(query: string, results: QuickShortcutItem[]) {
                e2eSearchFixture.value = { query, results };
            },
            setConversation(messages: SessionMessage[]) {
                sessionHistory.value = messages;
            },
            setAskUserRequest(request: E2eAskUserRequest) {
                if (request.kind === 'confirm') {
                    askUserStore.enqueueConfirm(request.options, () => undefined);
                } else {
                    askUserStore.enqueueApproval(request.payload, () => undefined);
                }
            },
            clearAskUser() {
                askUserStore.clearAll('e2e request reset');
            },
            async setLanguage(locale: AppLocale) {
                await settingsStore.initialize();
                await settingsStore.updateLanguage(locale);
            },
            async clearSessionToIdle() {
                await clearSessionToIdle();
            },
            getSessionExpandDebug() {
                return (
                    (
                        window as Window & {
                            __TOUCHAI_SESSION_EXPAND_DEBUG__?: { events: unknown[] };
                        }
                    ).__TOUCHAI_SESSION_EXPAND_DEBUG__ ?? null
                );
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
        void submitSearchQuery(normalizedText, widgetSnapshot);
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

    async function initialize(): Promise<boolean> {
        await initializeSearchViewForFirstPaint({
            initializeSettings: () => settingsStore.initialize(),
            initializeMcpStore: () => mcpStore.initialize(),
            syncWindowPinState,
            syncSearchWindowState,
            isE2eTestMode,
            autoConnectMcp: async () => {
                await mcpManager.autoConnect();
            },
            onReady: (ready) => {
                viewReady.value = ready;
            },
            logError: (message, error) => {
                log.error(message, error);
            },
        });
        if (!viewReady.value || searchViewListenersDisposed) return false;

        await nextTick();
        if (searchViewListenersDisposed) return false;
        return searchSurfacePreparationController.start();
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
            await closeSessionHistoryOverlay();
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
                void hideAllOverlays().catch((error) => {
                    log.error('[SearchView] failed to hide overlays before approval prompt', error);
                });
                askUserStore.enqueueApproval(
                    {
                        callId: approval.callId,
                        title: approval.title,
                        description: approval.description,
                        command: approval.command,
                        riskLabel: approval.riskLabel,
                        reason: approval.reason,
                        commandLabel: '鍛戒护棰勮',
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
                void hideAllOverlays().catch((error) => {
                    log.error('[SearchView] failed to hide overlays before question prompt', error);
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
        activeOverlay,
        () => {
            overlayRequiredViewportHeight.value = null;
        },
        { flush: 'sync' }
    );

    watch(
        [
            () => sessionHistory.value.length,
            () => Boolean(askUserStore.current),
            fillConversationAvailableHeight,
            effectiveWindowMaximized,
        ],
        () => {
            if (activeOverlay.value !== 'none') {
                void nextTick().then(() => overlayHost.value?.refreshPosition());
            }
        },
        { flush: 'post' }
    );

    watch(
        [sessionHistoryOverlayOpen, sessionList, sessionListQuery, isSessionListLoading],
        ([isOpen]) => {
            if (isOpen) void nextTick().then(() => overlayHost.value?.refreshPosition());
        },
        { flush: 'post' }
    );

    function handleSearchWindowResize() {
        handleHostViewportChange();
    }

    onMounted(() => {
        searchViewListenersDisposed = false;
        widgetBridgeWindow.sendPrompt = handleWidgetSendPrompt;
        widgetBridgeWindow.openLink = handleWidgetOpenLink;
        window.addEventListener('resize', handleSearchWindowResize);
        void initialize()
            .then((initialCommitSucceeded) => {
                if (!initialCommitSucceeded || searchViewListenersDisposed) return;
                return installE2eBridge();
            })
            .catch((error) => {
                viewReady.value = false;
                log.error('[SearchView] Failed to unlock the native search window:', error);
            });
    });

    onUnmounted(() => {
        cancelSessionExpansion();
        quickSearchHandoffLifecycle.dispatch('dispose');
        beginOverlayIntent();
        clearPendingOverlayFocus();
        searchViewListenersDisposed = true;
        window.removeEventListener('resize', handleSearchWindowResize);
        notifySearchSurfaceViewportChanged = () => undefined;
        searchSurfacePreparationController.dispose();
        disposeSearchPanelDragging();
        void disposeSearchPanelResizing().catch((error) => {
            log.error('[SearchView] Failed to finish search panel resizing:', error);
        });
        searchWindowRegionReporter.dispose();
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
    <div class="relative h-full w-full" :style="searchSurfaceStyle">
        <div
            ref="pageContainer"
            tabindex="-1"
            data-testid="search-view"
            :style="panelStyle"
            :class="[
                'relative flex min-h-0 w-full flex-col items-center focus:outline-none',
                fillConversationAvailableHeight || effectiveWindowMaximized ? 'h-full' : '',
            ]"
            @paste.capture="handlePagePaste"
        >
            <div
                data-testid="search-view-expand-frame"
                class="search-view-surface-viewport relative h-full min-h-0 w-full overflow-visible"
            >
                <div
                    data-testid="search-view-expand-clip"
                    class="search-view-surface-clip relative h-full min-h-0 w-full overflow-visible"
                >
                    <div
                        ref="searchViewCard"
                        data-testid="search-view-card"
                        :style="cardStyle"
                        :class="[
                            'search-view-container search-view-surface-card relative flex h-full min-h-0 w-full flex-col items-center overflow-hidden border-0',
                            isCardGrowing ? 'search-view-surface-card--revealing' : '',
                            isCardGrowing ? 'backdrop-blur-none' : 'backdrop-blur-xl',
                            !settledWindowMaximized ? 'search-surface-elevated' : '',
                            // The card always equals the host interior. A conversation
                            // keeps its editor on the bottom edge and reveals itself
                            // from the bottom up; the compact surface and the
                            // QuickSearch list hang from the top edge so the editor
                            // never sinks out of the frame.
                            //
                            // A handoff already is a conversation even before the submitted
                            // message lands: aligning that stack from the top left the card's
                            // spare height under the toolbar as a blank band, and the flip to
                            // bottom alignment when the message arrived moved the whole stack
                            // in one frame.
                            sessionHistory.length > 0 || quickSearchHandoff
                                ? 'justify-end'
                                : 'justify-start',
                        ]"
                    >
                        <div
                            ref="pageContent"
                            :style="pageContentStyle"
                            :class="[
                                'relative flex min-h-0 w-full flex-col',
                                sessionHistory.length > 0 ||
                                fillConversationAvailableHeight ||
                                effectiveWindowMaximized
                                    ? 'h-full min-h-0 flex-1'
                                    : '',
                            ]"
                        >
                            <div
                                v-if="searchViewContentReady && sessionHistory.length > 0"
                                ref="conversationContainer"
                                data-testid="conversation-panel-host"
                                class="isolate min-h-0 w-full flex-1 overflow-hidden"
                            >
                                <ConversationPanel
                                    ref="conversationPanel"
                                    :messages="sessionHistory"
                                    :is-loading="isLoading"
                                    :error="error"
                                    :is-pinned="isPinned"
                                    :is-maximized="isMaximized"
                                    :history-open="sessionHistoryOverlayOpen"
                                    :start-dragging="startSearchPanelDragging"
                                    @pin-change="handlePinChange"
                                    @maximize-toggle="handleToggleMaximize"
                                    @new-session="handleStartNewSession"
                                    @history-open-change="handleHistoryOpenChange"
                                    @history-prefetch="handleHistoryPrefetch"
                                    @drag-start="handleSearchPanelDragStart"
                                    @drag-end="handleSearchPanelDragEnd"
                                    @regenerate-message="handleRegenerateMessage"
                                    @content-resize="scheduleContentMeasurement()"
                                    @latest-content-visibility-change="
                                        handleLatestContentVisibilityChange
                                    "
                                />
                            </div>
                            <div
                                v-if="
                                    searchViewContentReady &&
                                    sessionHistory.length > 0 &&
                                    !askUserStore.current
                                "
                                class="w-full border-t-[0.5px] border-gray-300/80"
                            ></div>
                            <div
                                v-if="searchViewContentReady && askUserStore.current"
                                aria-hidden="true"
                                class="ask-user-divider relative z-10 w-full"
                            ></div>
                            <AskUserPanel v-if="searchViewContentReady && askUserStore.current" />
                            <div
                                v-if="viewReady && !askUserStore.current"
                                ref="inputArea"
                                class="relative flex w-full flex-col"
                                :class="
                                    !floatingPicker && (quickSearchOpen || skillAutocompleteOpen)
                                        ? 'min-h-0 flex-1'
                                        : 'shrink-0'
                                "
                            >
                                <SearchBar
                                    ref="searchBar"
                                    :disabled="
                                        isWaitingForCompletion || Boolean(pendingToolApproval)
                                    "
                                    :query-text="queryText"
                                    :attachments="attachments"
                                    :complete-file="completeFile"
                                    :move-file-selection="moveFileSelection"
                                    :file-picker-context="filePickerContext"
                                    :auto-select-first="floatingPicker"
                                    :show-empty-results="floatingPicker"
                                    :model-override="modelOverride"
                                    :start-dragging="startSearchPanelDragging"
                                    @file-autocomplete-query-change="
                                        handleFileAutocompleteQueryChange
                                    "
                                    @file-input-active-change="fileInputActive = $event"
                                    @skill-autocomplete-open-change="
                                        handleSkillAutocompleteOpenChange
                                    "
                                    @skill-input-active-change="handleSkillInputActiveChange"
                                    @update:query-text="handleQueryTextChange"
                                    @attachment-remove-request="handleAttachmentRemoveRequest"
                                    @attachment-restore-request="restoreAttachment"
                                    @model-change="handleModelChange"
                                    @cursor-context-change="handleCursorContextChange"
                                    @model-override-change="handleModelOverrideChange"
                                    @request-prefetch-model-dropdown="handleModelDropdownPrefetch"
                                    @request-toggle-model-dropdown="
                                        handleToggleModelDropdownRequest
                                    "
                                    @drag-start="handleSearchPanelDragStart"
                                    @drag-end="handleSearchPanelDragEnd"
                                >
                                    <template #results="{ skillPicker, selectSkill }">
                                        <div
                                            v-if="
                                                searchViewContentReady &&
                                                (sessionHistory.length === 0 ||
                                                    quickSearchHandoff ||
                                                    fileAutocompleteQuery !== null ||
                                                    skillPicker)
                                            "
                                            v-show="quickSearchOpen || skillPicker"
                                            ref="pickerContainer"
                                            :class="
                                                floatingPicker
                                                    ? 'absolute bottom-full left-1/2 z-20 w-4/5 -translate-x-1/2 bg-transparent'
                                                    : 'flex min-h-0 flex-1 flex-col justify-end'
                                            "
                                        >
                                            <div
                                                v-show="quickSearchOpen && fileSearchEnabled"
                                                class="quick-search-handoff-slot"
                                                :class="
                                                    floatingPicker
                                                        ? ''
                                                        : 'flex min-h-0 flex-1 flex-col'
                                                "
                                            >
                                                <div
                                                    v-if="
                                                        sessionHistory.length === 0 ||
                                                        fileAutocompleteQuery !== null ||
                                                        quickSearchHandoff
                                                    "
                                                    v-show="quickSearchOpen && fileSearchEnabled"
                                                    ref="quickSearchHandoffShell"
                                                    data-testid="quick-search-handoff-shell"
                                                    :class="[
                                                        floatingPicker
                                                            ? 'w-full'
                                                            : 'quick-search-handoff-shell w-full flex-1',
                                                        quickSearchRevealPhase === 'measuring'
                                                            ? 'quick-search-handoff-shell--measuring'
                                                            : '',
                                                        quickSearchRevealPhase === 'open' &&
                                                        quickSearchOpen
                                                            ? 'quick-search-handoff-shell--open'
                                                            : '',
                                                        quickSearchRevealPhase === 'folding'
                                                            ? 'quick-search-handoff-shell--folding'
                                                            : '',
                                                        quickSearchRevealPhase === 'handoff'
                                                            ? 'quick-search-handoff-shell--handoff'
                                                            : '',
                                                    ]"
                                                    :style="{
                                                        visibility:
                                                            quickSearchRevealPhase === 'measuring'
                                                                ? 'hidden'
                                                                : undefined,
                                                    }"
                                                >
                                                    <div
                                                        :class="
                                                            floatingPicker
                                                                ? ''
                                                                : 'quick-search-handoff-shell__content flex min-h-0 flex-col justify-end overflow-hidden'
                                                        "
                                                    >
                                                        <QuickSearchPanel
                                                            ref="quickSearchPanel"
                                                            :open="quickSearchOpen"
                                                            :search-query="
                                                                fileAutocompleteQuery ?? queryText
                                                            "
                                                            :enabled="quickSearchEligible"
                                                            :get-activation-context="
                                                                captureSearchActivationContext
                                                            "
                                                            :reference-mode="
                                                                fileAutocompleteQuery !== null
                                                            "
                                                            :max-height="filePickerMaxHeight"
                                                            :compact="floatingPicker"
                                                            :handoff="quickSearchHandoff"
                                                            @action-outcome="
                                                                handleSearchActionOutcome
                                                            "
                                                            @reference="handleFileReference"
                                                            @content-resize="
                                                                scheduleContentMeasurement()
                                                            "
                                                            @reference-state-change="
                                                                filePickerContext = $event
                                                            "
                                                            @blank-click="
                                                                handleQuickSearchBlankClick
                                                            "
                                                            @update:open="
                                                                handleQuickSearchOpenChange
                                                            "
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                            <SkillPickerPanel
                                                v-if="skillPicker"
                                                ref="skillPickerPanel"
                                                :picker="skillPicker"
                                                :max-height="skillPickerMaxHeight"
                                                :compact="floatingPicker"
                                                @select="selectSkill"
                                                @content-resize="scheduleContentMeasurement()"
                                            />
                                        </div>
                                    </template>
                                </SearchBar>
                            </div>
                        </div>
                        <SearchPanelResizeHandles
                            :enabled="logicalPanelResizeEnabled"
                            @resize-start="handleSearchPanelResizeStart"
                        />
                    </div>
                </div>
            </div>
        </div>
        <SearchOverlayHost
            ref="overlayHost"
            :open="activeOverlay !== 'none'"
            :reveal="overlayPositionReady"
            :close-immediately="closeOverlayImmediately"
            :anchor="overlayAnchorElement"
            :position-anchor="overlayPositionAnchorElement"
            :layout-target="pageContainer"
            preferred-side="bottom"
            :allow-flip="false"
            :max-viewport-height="overlayMaxViewportHeight"
            :min-viewport-top="overlayMinViewportTop"
            :min-viewport-left="overlayMinViewportLeft"
            :max-viewport-right="overlayMaxViewportRight"
            :align="
                renderedOverlay === 'session-history' && sessionHistory.length > 0 ? 'end' : 'start'
            "
            :gap="overlayPositionGap"
            :left-align-element="
                renderedOverlay === 'model-dropdown' || overlayFloatsOverResults
                    ? searchViewCard
                    : null
            "
            :overlay-on-anchor="overlayFloatsOverResults"
            @after-leave="handleOverlayAfterLeave"
            @outside-click="handleOverlayOutsideClick"
            @positioned="handleOverlayPositioned"
            @region-change="handleOverlayRegionChange"
            @revealed="focusPendingOverlayWhenReady"
        >
            <ModelDropdownPopup
                v-if="renderedOverlay === 'model-dropdown'"
                ref="modelDropdownOverlay"
                :data="getModelDropdownData()"
                :on-model-select="handleModelSelect"
                :on-search-query-change="handleModelSearchQueryChange"
                @close="closeModelDropdown()"
            />
            <SessionHistoryPopover
                v-else-if="renderedOverlay === 'session-history'"
                ref="sessionHistoryPopover"
                :data="getSessionHistoryOverlayData()"
                :on-session-open="(sessionId) => handleOpenSession(sessionId, 'history')"
                :on-search-query-change="handleSessionSearchQueryChange"
                @close="closeSessionHistoryOverlay()"
            />
        </SearchOverlayHost>
    </div>
</template>
