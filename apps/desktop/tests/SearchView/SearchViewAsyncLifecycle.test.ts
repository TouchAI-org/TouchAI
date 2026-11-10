import { shallowMount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, type Ref, ref, watch } from 'vue';

import type { AskUserQuestion } from '@/services/AgentService/contracts/tooling';
import type { PendingUserQuestionView } from '@/services/AgentService/task/types';
import type { PendingToolApproval, SessionMessage } from '@/types/session';
import type { SkillPickerState } from '@/views/SearchView/components/SearchBar/composables/useSkillAutocomplete';
import SearchView from '@/views/SearchView/index.vue';
import type { SearchSurfacePreparationControllerOptions } from '@/views/SearchView/searchSurfacePreparation';

const {
    askUserState,
    controllerMock,
    clipboardState,
    currentWindowMock,
    draftState,
    eventServiceMock,
    keyboardState,
    lifecycleState,
    requestFlowState,
    resizeState,
    regionState,
    runtimeModeState,
    startupState,
    surfacePreparationState,
} = vi.hoisted(() => ({
    askUserState: {
        current: null,
        cancelByApprovalCallId: vi.fn(),
        cancelByQuestionCallId: vi.fn(),
        enqueueApproval: vi.fn(),
        enqueueQuestion: vi.fn(),
    },
    controllerMock: {
        closeQuickSearch: vi.fn(),
        focusSearchInput: vi.fn(),
        getModelDropdownAnchor: vi.fn(),
        getModelDropdownContext: vi.fn(),
        invalidateModelDropdownData: vi.fn(),
        loadActiveModel: vi.fn(),
        prefetchModelDropdownData: vi.fn(),
        prepareModelDropdownOpen: vi.fn(),
        selectModelFromDropdown: vi.fn(),
        isSkillAutocompleteOpen: vi.fn(() => false),
        closeSkillAutocomplete: vi.fn(),
        hasInputContent: vi.fn(() => false),
    },
    clipboardState: {
        consumeShortcutAutoPastePayload: vi.fn(),
    },
    draftState: {
        clearDraft: vi.fn(),
        importClipboardPayload: vi.fn(),
    },
    currentWindowMock: {
        onMoved: vi.fn(),
        outerPosition: vi.fn(),
        outerSize: vi.fn(),
        innerSize: vi.fn(),
        scaleFactor: vi.fn(),
    },
    eventServiceMock: {
        on: vi.fn(),
    },
    keyboardState: {
        options: null as {
            hideSearchWindow: () => Promise<void>;
            handleSubmit?: (query: string) => Promise<void>;
        } | null,
    },
    lifecycleState: {
        options: null as Record<string, unknown> | null,
        hideSearchWindow: vi.fn(),
    },
    requestFlowState: {
        current: null as {
            sessionHistoryOverlayOpen: Ref<boolean>;
            handleSubmit: ReturnType<typeof vi.fn>;
            clearSession: ReturnType<typeof vi.fn>;
            openSession: ReturnType<typeof vi.fn>;
            markHistorySelectionPending: ReturnType<typeof vi.fn>;
            abandonHistorySelection: ReturnType<typeof vi.fn>;
            sessionHistory: Ref<SessionMessage[]>;
            currentSessionId: Ref<number | null>;
            pendingToolApproval: Ref<PendingToolApproval | null>;
            pendingUserQuestion: Ref<PendingUserQuestionView | null>;
            approvePendingToolApproval: ReturnType<typeof vi.fn>;
            rejectPendingToolApproval: ReturnType<typeof vi.fn>;
            settleUserQuestion: ReturnType<typeof vi.fn>;
        } | null,
    },
    resizeState: {
        options: null as { resizeEnabled?: Ref<boolean> } | null,
        remeasureTargetHeight: vi.fn(),
        playSessionExpandAnimation: vi.fn(),
        collapseSessionToIdle: vi.fn(),
        resetSearchWindowBounds: vi.fn(),
        measureTargetHeight: vi.fn(),
    },
    regionState: { flush: vi.fn<() => Promise<boolean>>() },
    runtimeModeState: {
        isE2eTestMode: vi.fn(),
    },
    startupState: {
        initialize: vi.fn(async (options: { onReady: (ready: boolean) => void }) =>
            options.onReady(true)
        ),
    },
    surfacePreparationState: {
        options: null as SearchSurfacePreparationControllerOptions | null,
        start: vi.fn<() => Promise<boolean>>(),
        notifyViewportChanged: vi.fn(),
        dispose: vi.fn(),
    },
}));

vi.mock('@composables/useSessionStatus', async () => {
    const { ref } = await import('vue');
    return {
        useSessionStatus: () => ({
            sessionStatuses: ref(new Map()),
            refreshAllStatuses: vi.fn(),
        }),
    };
});

vi.mock('@services/EventService', () => ({
    AppEvent: {
        SEARCH_SURFACE_SHOWN: 'search-surface-shown',
    },
    eventService: eventServiceMock,
}));

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            hideSearchWindow: vi.fn().mockResolvedValue(undefined),
            markSearchWindowReady: vi.fn().mockResolvedValue(undefined),
            openSettingsWindow: vi.fn().mockResolvedValue(undefined),
            setSearchWindowRegions: vi.fn().mockResolvedValue(undefined),
        },
    },
}));

vi.mock('@services/NotificationService', () => ({
    notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => currentWindowMock,
}));

vi.mock('pinia', async () => {
    const { ref } = await import('vue');
    return {
        storeToRefs: () => ({
            searchWindowDefaultSize: ref({ width: 750, height: 60 }),
            searchKeybindings: ref({
                'search.history.open': null,
                'search.input.focus': null,
                'search.session.new': null,
                'search.session.reopenLastClosed': null,
                'search.model.toggle': null,
                'search.quickSearch.toggleView': null,
                'search.window.pin': null,
                'search.window.maximize': null,
                'search.settings.open': null,
            }),
        }),
    };
});

vi.mock('@/i18n', () => ({
    t: (key: string) => key,
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        autoConnect: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@/services/ClipboardService', () => ({
    clipboardService: {
        consumeShortcutAutoPastePayload: clipboardState.consumeShortcutAutoPastePayload,
    },
}));

vi.mock('@/stores/askUser', () => ({
    useAskUserStore: () => askUserState,
}));

vi.mock('@/stores/mcp', () => ({
    useMcpStore: () => ({
        initialize: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => ({
        initialize: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('@/utils/runtimeMode', () => ({
    isE2eTestMode: runtimeModeState.isE2eTestMode,
}));

vi.mock('@/views/SearchView/composables/searchInteraction', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('@/views/SearchView/composables/searchInteraction')>();
    const { computed } = await import('vue');
    return {
        ...actual,
        useQuickSearchCoordinator: () => ({
            isQuickSearchOpen: computed(() => false),
            shouldShowQuickSearch: () => true,
            shouldTriggerQuickSearch: () => false,
        }),
    };
});

vi.mock('@/views/SearchView/composables/useSearchInput', () => ({
    useSearchAttachments: () => ({
        handleModelChange: vi.fn(),
        createAttachmentFromClipboardPath: vi.fn(),
        removeAttachment: vi.fn(),
        clearAttachments: vi.fn(),
        getSupportedAttachments: vi.fn(() => []),
        getUnsupportedAttachmentMessage: vi.fn(() => null),
        syncAttachmentSupport: vi.fn(),
    }),
    useSearchDraftController: () => ({
        clearDraft: draftState.clearDraft,
        importClipboardPayload: draftState.importClipboardPayload,
    }),
}));

vi.mock('@/views/SearchView/composables/useSearchPage', async () => {
    const { ref } = await import('vue');
    return {
        filterModelDropdownItems: (models: unknown[]) => models,
        useSearchKeyboard: (options: { hideSearchWindow: () => Promise<void> }) => {
            keyboardState.options = options;
            return {
                routeSearchSurfaceCommand: vi.fn(() => true),
            };
        },
        useSearchPageController: () => controllerMock,
        useSearchPageLifecycle: (options: Record<string, unknown>) => {
            lifecycleState.options = options;
            return {
                hideSearchWindow: lifecycleState.hideSearchWindow,
                handleSearchSurfaceShown: options.handleSearchSurfaceShown,
                handleSearchSurfaceHidden: options.handleSearchSurfaceHidden,
            };
        },
        useSearchPanelFocusRestore: () => ({
            handleQuickSearchBlankClick: vi.fn(),
        }),
        useSearchWindowPin: () => ({
            isPinned: ref(false),
            syncWindowPinState: vi.fn().mockResolvedValue(undefined),
            setWindowPinned: vi.fn().mockResolvedValue(undefined),
            toggleWindowPin: vi.fn().mockResolvedValue(undefined),
        }),
    };
});

vi.mock('@/views/SearchView/composables/useSearchPanelDragging', async () => {
    const { ref } = await import('vue');
    return {
        useSearchPanelDragging: () => ({
            panelDragStyle: ref(undefined),
            startDragging: vi.fn(),
            getPanelOffset: vi.fn(() => ({ x: 0, y: 0 })),
            setPanelOffset: vi.fn(),
            setPanelFrame: vi.fn(),
            reconcilePanelOffsetToViewport: vi.fn(),
            cancelDragging: vi.fn(() => false),
            dispose: vi.fn(),
        }),
    };
});

vi.mock('@/views/SearchView/composables/useSearchPanelInteraction', async () => {
    const { ref } = await import('vue');
    return {
        useSearchPanelInteraction: () => ({
            active: ref(false),
            begin: vi.fn(),
            end: vi.fn(),
        }),
    };
});

vi.mock('@/views/SearchView/composables/useSearchPanelResizing', () => ({
    useSearchPanelResizing: () => ({
        startResizing: vi.fn().mockResolvedValue(undefined),
        cancelResizing: vi.fn(() => false),
        dispose: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('@/views/SearchView/composables/useSearchRequest', async () => {
    const { ref } = await import('vue');
    return {
        useSearchRequestFlow: () => {
            const result = {
                pendingRequest: ref(null),
                isLoading: ref(false),
                error: ref(null),
                currentSessionId: ref<number | null>(null),
                sessionHistory: ref([]),
                sessionHistoryOverlayOpen: ref(false),
                sessionList: ref([]),
                sessionListQuery: ref(''),
                isSessionListLoading: ref(false),
                clearSession: vi.fn(),
                setSessionHistoryOverlayOpen: vi.fn(),
                beginHistoryInteraction: vi.fn(),
                reportHistoryInteractionOpened: vi.fn(),
                markHistorySelectionPending: vi.fn(() => null),
                abandonHistorySelection: vi.fn(),
                updateSessionSearchQuery: vi.fn().mockResolvedValue(undefined),
                refreshSessionList: vi.fn().mockResolvedValue(undefined),
                ensureSessionListLoaded: vi.fn().mockResolvedValue(undefined),
                startNewSession: vi.fn(),
                openSession: vi.fn().mockResolvedValue(undefined),
                pendingToolApproval: ref(null),
                pendingUserQuestion: ref(null),
                approvePendingToolApproval: vi.fn(),
                rejectPendingToolApproval: vi.fn(),
                settleUserQuestion: vi.fn(),
                handleSubmit: vi.fn().mockResolvedValue(undefined),
                clearAll: vi.fn(),
                cancelRequest: vi.fn(),
                handleRegenerateMessage: vi.fn().mockResolvedValue(undefined),
            };
            result.setSessionHistoryOverlayOpen.mockImplementation(async (open: boolean) => {
                result.sessionHistoryOverlayOpen.value = open;
            });
            requestFlowState.current = result;
            return result;
        },
    };
});

vi.mock('@/views/SearchView/composables/useSearchWindowResize', async () => {
    const { ref } = await import('vue');
    return {
        useSearchWindowResize: (options: { resizeEnabled?: Ref<boolean> }) => {
            resizeState.options = options;
            return {
                contentReady: ref(true),
                currentHeight: ref(60),
                cardHeight: ref(60),
                cardReveal: ref(0),
                isCardGrowing: ref(false),
                isMaximized: ref(false),
                effectiveWindowMaximized: ref(false),
                settledWindowMaximized: ref(false),
                fillConversationAvailableHeight: ref(false),
                skillPickerMaxHeight: ref(299.5),
                monitorHost: ref(false),
                measurementHold: ref(false),
                panelStyle: ref(undefined),
                isSessionExpandAnimating: ref(false),
                allowLogicalPanelHeightResize: ref(true),
                toggleMaximize: vi.fn().mockResolvedValue(undefined),
                syncWindowState: vi.fn().mockResolvedValue(undefined),
                remeasureTargetHeight: resizeState.remeasureTargetHeight,
                measureTargetHeight: resizeState.measureTargetHeight,
                scheduleMeasurement: vi.fn(),
                playSessionExpandAnimation: resizeState.playSessionExpandAnimation,
                collapseSessionToIdle: resizeState.collapseSessionToIdle,
                sessionExpandMotion: ref(undefined),
                sessionExpandCardStyle: ref(undefined),
                sessionExpandInnerStyle: ref(undefined),
                resetSearchWindowBounds: resizeState.resetSearchWindowBounds,
                beginLogicalPanelResize: vi.fn(),
                previewLogicalPanelResize: vi.fn(),
                commitLogicalPanelResize: vi.fn().mockResolvedValue(undefined),
                cancelLogicalPanelResize: vi.fn(),
            };
        },
    };
});

vi.mock('@/views/SearchView/searchWindowRegions', () => ({
    createSearchWindowRegionReporter: () => ({
        schedule: vi.fn(),
        flush: regionState.flush,
        dispose: vi.fn(),
    }),
    createSearchWindowRegionSignature: vi.fn(() => ''),
    resolveSearchWindowRegionGeometry: vi.fn(() => ({ regions: [] })),
}));

vi.mock('@/views/SearchView/searchSurfacePreparation', () => ({
    createSearchSurfacePreparationController: (
        options: SearchSurfacePreparationControllerOptions
    ) => {
        surfacePreparationState.options = options;
        return surfacePreparationState;
    },
    settleSearchSurfaceViewport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/views/SearchView/startup', () => ({
    initializeSearchViewForFirstPaint: startupState.initialize,
}));

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

async function flushPromises() {
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
}

interface SearchViewSetupState {
    activeOverlay: 'none' | 'model-dropdown' | 'session-history';
    renderedOverlay: 'none' | 'model-dropdown' | 'session-history';
    modelOverride: { modelId: string | null; providerId: number | null };
    modelDropdownState: { isOpen: boolean };
    overlayAnchorElement: HTMLElement | null;
    overlayPositionReady: boolean;
    pageContent: HTMLElement;
    fillConversationAvailableHeight: boolean;
    effectiveWindowMaximized: boolean;
    quickSearchOpen: boolean;
    quickSearchRevealPhase: string;
    surfaceMeasurementHold: boolean;
    handleQuickSearchOpenChange: (open: boolean) => void;
    clearSessionToIdle: () => Promise<void>;
    handleOpenSession: (id: number, origin: 'history') => Promise<void>;
    handleModelSelect: (modelDbId: number) => Promise<void>;
    handleToggleModelDropdownRequest: () => Promise<void>;
    handleOverlayPositioned: (position: {
        left: number;
        top: number;
        side: 'top' | 'bottom';
        requiredViewportHeight: number | null;
    }) => void;
    hideAllOverlays: (restoreFocus?: boolean) => Promise<void>;
    openHistoryDialog: () => Promise<void>;
    tryShortcutAutoPaste: (isCurrent?: () => boolean) => Promise<void>;
    searchInteractionContext: {
        markWindowHidden: (input: {
            hideReason: 'app-blur-hide' | 'manual-dismiss' | 'policy-toggle-hide';
            hiddenAt: number;
        }) => void;
        recordActivation: (source: 'shortcut' | 'notification' | 'manual') => void;
        setWindowFocused: (focused: boolean) => void;
    };
}

function getSetupState(wrapper: VueWrapper) {
    return (wrapper.vm as unknown as { $: { setupState: SearchViewSetupState } }).$.setupState;
}

describe('SearchView async overlay and listener lifecycle', () => {
    const wrappers: VueWrapper[] = [];

    beforeEach(() => {
        vi.clearAllMocks();
        clipboardState.consumeShortcutAutoPastePayload.mockResolvedValue(null);
        draftState.clearDraft.mockReset();
        draftState.importClipboardPayload.mockResolvedValue(undefined);
        keyboardState.options = null;
        lifecycleState.options = null;
        lifecycleState.hideSearchWindow.mockResolvedValue(undefined);
        requestFlowState.current = null;
        runtimeModeState.isE2eTestMode.mockResolvedValue(false);
        resizeState.remeasureTargetHeight.mockResolvedValue(undefined);
        resizeState.playSessionExpandAnimation.mockResolvedValue(undefined);
        resizeState.collapseSessionToIdle.mockResolvedValue(true);
        resizeState.resetSearchWindowBounds.mockResolvedValue(true);
        resizeState.options = null;
        resizeState.measureTargetHeight.mockReturnValue(400);
        regionState.flush.mockResolvedValue(true);
        surfacePreparationState.start.mockResolvedValue(true);
        delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;

        controllerMock.focusSearchInput.mockResolvedValue(undefined);
        controllerMock.isSkillAutocompleteOpen.mockReturnValue(false);
        controllerMock.closeSkillAutocomplete.mockReset();
        controllerMock.hasInputContent.mockReturnValue(false);
        controllerMock.getModelDropdownAnchor.mockReturnValue(document.createElement('button'));
        controllerMock.getModelDropdownContext.mockReturnValue({
            activeModelId: null,
            activeProviderId: null,
            selectedModelId: null,
            selectedProviderId: null,
            models: [],
        });
        controllerMock.loadActiveModel.mockResolvedValue(undefined);
        controllerMock.prefetchModelDropdownData.mockResolvedValue(undefined);
        controllerMock.prepareModelDropdownOpen.mockResolvedValue(undefined);
        controllerMock.selectModelFromDropdown.mockResolvedValue({
            modelId: null,
            providerId: null,
        });
        currentWindowMock.onMoved.mockResolvedValue(() => undefined);
        currentWindowMock.outerPosition.mockResolvedValue({ x: 100, y: 200 });
        currentWindowMock.outerSize.mockResolvedValue({ width: 766, height: 98 });
        currentWindowMock.innerSize.mockResolvedValue({ width: 750, height: 60 });
        currentWindowMock.scaleFactor.mockResolvedValue(1);
        eventServiceMock.on.mockResolvedValue(() => undefined);
    });

    afterEach(() => {
        for (const wrapper of wrappers.splice(0)) {
            wrapper.unmount();
        }
        document.body.innerHTML = '';
        delete (window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__;
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function mountSearchView(skillPicker = ref<SkillPickerState | null>(null)) {
        controllerMock.isSkillAutocompleteOpen.mockImplementation(() => skillPicker.value !== null);
        controllerMock.closeSkillAutocomplete.mockImplementation(() => {
            skillPicker.value = null;
        });
        const overlayContent = defineComponent({
            setup(_, { expose }) {
                expose({ handleOverlayShown: vi.fn(), handleKeyDown: vi.fn() });
                return () => h('div');
            },
        });
        const overlayHost = defineComponent({
            name: 'SearchOverlayHost',
            props: { open: Boolean },
            setup(_, { expose, slots }) {
                expose({ refreshPosition: vi.fn().mockResolvedValue(undefined) });
                return () => h('div', slots.default?.());
            },
        });
        const wrapper = shallowMount(SearchView, {
            global: {
                stubs: {
                    SearchBar: defineComponent({
                        name: 'SearchBar',
                        inheritAttrs: false,
                        props: { queryText: { type: String, default: '' } },
                        emits: [
                            'update:queryText',
                            'skillAutocompleteOpenChange',
                            'skillInputActiveChange',
                            'requestToggleModelDropdown',
                        ],
                        setup(_, { slots, emit }) {
                            watch(
                                skillPicker,
                                (picker) => emit('skillAutocompleteOpenChange', picker !== null),
                                { immediate: true, flush: 'post' }
                            );
                            return () => [
                                h('div', { 'data-testid': 'test-search-editor' }),
                                slots.results?.({
                                    skillPicker: skillPicker.value,
                                    selectSkill: () => undefined,
                                }),
                            ];
                        },
                    }),
                    SearchOverlayHost: overlayHost,
                    ModelDropdownPopup: overlayContent,
                    SessionHistoryPopover: overlayContent,
                    ConversationPanel: defineComponent({
                        name: 'ConversationPanel',
                        setup(_, { expose }) {
                            expose({ getContentHeight: () => 340, focus: vi.fn() });
                            return () => h('div', 'Conversation');
                        },
                    }),
                    QuickSearchPanel: defineComponent({
                        name: 'QuickSearchPanel',
                        props: {
                            open: Boolean,
                            enabled: Boolean,
                            handoff: Boolean,
                            searchQuery: { type: String, default: '' },
                            referenceMode: Boolean,
                        },
                        setup(_, { expose }) {
                            expose({ close: vi.fn() });
                            return () => h('div', 'Search results');
                        },
                    }),
                },
            },
        });
        wrappers.push(wrapper);
        return wrapper;
    }

    function createSkillPicker(): SkillPickerState {
        return {
            listId: 'skill-list',
            query: 'review',
            loading: false,
            error: false,
            candidates: [
                {
                    name: 'review',
                    description: 'Review a change',
                    shortDescription: null,
                    path: '/skills/review/SKILL.md',
                    directory: '/skills/review',
                },
            ],
            highlightedIndex: 0,
        };
    }

    it('user given a conversation and skill draft when typing @ then searches the local filename in the existing file panel', async () => {
        const wrapper = mountSearchView();
        await flushPromises();
        requestFlowState.current!.sessionHistory.value = [
            { id: 'prior', role: 'user', content: 'previous', parts: [], timestamp: 1 },
        ];
        await nextTick();
        expect(wrapper.findComponent({ name: 'QuickSearchPanel' }).exists()).toBe(false);
        const editor = wrapper.findComponent({ name: 'SearchBar' });
        editor.vm.$emit('skillInputActiveChange', true);
        editor.vm.$emit('update:queryText', 'Please compare\n@README');
        editor.vm.$emit('fileInputActiveChange', true);
        editor.vm.$emit('fileAutocompleteQueryChange', 'README');
        await nextTick();
        const panel = wrapper.findComponent({ name: 'QuickSearchPanel' });
        expect(panel.props()).toMatchObject({
            enabled: true,
            referenceMode: true,
            searchQuery: 'README',
        });
        expect(wrapper.find('[data-testid="conversation-panel-host"]').exists()).toBe(true);
        editor.vm.$emit('fileAutocompleteQueryChange', null);
        await nextTick();
        expect(wrapper.findComponent({ name: 'QuickSearchPanel' }).exists()).toBe(false);
        expect(editor.props('queryText')).toBe('Please compare\n@README');
    });

    it.each(['/', '$'])(
        'user sees a %s skill picker in a conversation without mounting the file search adapter',
        async (prefix) => {
            const picker = ref<SkillPickerState | null>(null);
            const wrapper = mountSearchView(picker);
            await flushPromises();
            expect(wrapper.findComponent({ name: 'QuickSearchPanel' }).exists()).toBe(true);
            requestFlowState.current!.sessionHistory.value = [
                { id: 'previous', role: 'user', content: 'previous', parts: [], timestamp: 1 },
            ];
            await nextTick();
            const editor = wrapper.findComponent({ name: 'SearchBar' });
            editor.vm.$emit('update:queryText', `${prefix}review`);
            editor.vm.$emit('skillInputActiveChange', true);
            picker.value = createSkillPicker();
            await nextTick();

            expect(wrapper.findComponent({ name: 'SkillPickerPanel' }).exists()).toBe(true);
            expect(wrapper.findComponent({ name: 'QuickSearchPanel' }).exists()).toBe(false);
            expect(wrapper.find('[data-testid="conversation-panel-host"]').exists()).toBe(true);
        }
    );

    it('user retains the skill query and highlighted row after the native surface hides and reopens', async () => {
        const picker = ref<SkillPickerState | null>(createSkillPicker());
        const wrapper = mountSearchView(picker);
        await flushPromises();
        const editor = wrapper.findComponent({ name: 'SearchBar' });
        editor.vm.$emit('update:queryText', '/review');
        editor.vm.$emit('skillInputActiveChange', true);
        await nextTick();
        const reconcile = lifecycleState.options!.reconcileSearchOverlays as (
            restoreFocus?: boolean
        ) => Promise<void>;
        const hidden = lifecycleState.options!.onSurfaceHidden as () => Promise<void>;
        const visibility = lifecycleState.options!.onSurfaceVisibilityChange as (
            visible: boolean
        ) => void;

        await reconcile(false);
        await hidden();
        visibility(true);
        await reconcile();
        await nextTick();

        const panel = wrapper.findComponent({ name: 'SkillPickerPanel' });
        expect(panel.exists()).toBe(true);
        expect(panel.props('picker')).toMatchObject({ query: 'review', highlightedIndex: 0 });
        expect(editor.props('queryText')).toBe('/review');
    });

    it.each(['model', 'history'] as const)(
        'user can open the %s overlay from Skills while preserving their query',
        async (overlay) => {
            const picker = ref<SkillPickerState | null>(createSkillPicker());
            const wrapper = mountSearchView(picker);
            await flushPromises();
            const editor = wrapper.findComponent({ name: 'SearchBar' });
            editor.vm.$emit('update:queryText', '/review');
            editor.vm.$emit('skillInputActiveChange', true);
            await nextTick();

            if (overlay === 'model') {
                editor.vm.$emit('requestToggleModelDropdown');
                for (let tick = 0; tick < 8; tick += 1) await flushPromises();
            } else {
                await getSetupState(wrapper).openHistoryDialog();
            }

            expect(wrapper.findComponent({ name: 'SearchOverlayHost' }).props('open')).toBe(true);
            expect(wrapper.findComponent({ name: 'SkillPickerPanel' }).exists()).toBe(false);
            expect(picker.value).toBeNull();
            expect(editor.props('queryText')).toBe('/review');
        }
    );

    it('user keeps their active skill draft when a completed conversation is eligible for timeout cleanup', async () => {
        const wrapper = mountSearchView();
        requestFlowState.current!.currentSessionId.value = 17;
        requestFlowState.current!.sessionHistory.value = [
            { id: 'completed', role: 'assistant', content: 'done', parts: [], timestamp: 1 },
        ];
        getSetupState(wrapper).searchInteractionContext.setWindowFocused(true);
        await nextTick();
        const shouldClear = lifecycleState.options!.shouldClearSessionAfterTimeout as () => boolean;
        expect(shouldClear()).toBe(true);

        controllerMock.hasInputContent.mockReturnValue(true);
        expect(shouldClear()).toBe(false);
    });

    it('user gets the replacement approval prompt when a reused call id has a new decision', async () => {
        mountSearchView();
        await flushPromises();
        const approval = {
            callId: 'call-approval',
            messageId: 'message-1',
            title: 'Run command',
            description: 'Review the command',
            command: 'printf test',
            riskLabel: 'Low',
            reason: 'Test',
            approveLabel: 'Run',
            rejectLabel: 'Cancel',
            enterHint: 'Enter to approve',
            escHint: 'Esc to reject',
            keyboardApproveAt: Date.now() + 450,
            decisionId: 'decision-1',
        } satisfies PendingToolApproval;
        requestFlowState.current!.pendingToolApproval.value = approval;
        await flushPromises();

        requestFlowState.current!.pendingToolApproval.value = {
            ...approval,
            decisionId: 'decision-2',
        };
        await flushPromises();

        expect(askUserState.cancelByApprovalCallId).toHaveBeenCalledWith('call-approval');
        expect(askUserState.enqueueApproval).toHaveBeenCalledTimes(2);
        const resolveCurrentApproval = askUserState.enqueueApproval.mock.calls[1]![1] as (
            approved: boolean
        ) => void;
        resolveCurrentApproval(true);
        expect(requestFlowState.current!.approvePendingToolApproval).toHaveBeenCalledWith(
            'call-approval',
            'decision-2'
        );
    });

    it('user gets the replacement question prompt when a reused call id has a new decision', async () => {
        mountSearchView();
        await flushPromises();
        const question: AskUserQuestion = {
            question: 'Which environment?',
            header: 'Environment',
            options: [{ label: 'Staging' }, { label: 'Production' }],
        };
        requestFlowState.current!.pendingUserQuestion.value = {
            callId: 'call-question',
            sourceMessageId: 'message-1',
            questions: [question],
            createdAt: 1,
            decisionId: 'decision-1',
        };
        await flushPromises();

        requestFlowState.current!.pendingUserQuestion.value = {
            callId: 'call-question',
            sourceMessageId: 'message-2',
            questions: [question],
            createdAt: 2,
            decisionId: 'decision-2',
        };
        await flushPromises();

        expect(askUserState.cancelByQuestionCallId).toHaveBeenCalledWith('call-question');
        expect(askUserState.enqueueQuestion).toHaveBeenCalledTimes(2);
        const resolveCurrentQuestion = askUserState.enqueueQuestion.mock.calls[1]![1] as (
            answers: Array<{ questionIndex: number; selectedLabels: string[]; skipped: boolean }>
        ) => void;
        const answers = [{ questionIndex: 0, selectedLabels: ['Staging'], skipped: false }];
        resolveCurrentQuestion(answers);
        expect(requestFlowState.current!.settleUserQuestion).toHaveBeenCalledWith(
            'call-question',
            answers,
            'decision-2'
        );
    });

    it('remeasures the host when positioned overlay bounds change the required viewport height', async () => {
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);

        setup.handleOverlayPositioned({
            left: 12,
            top: 68,
            side: 'bottom',
            requiredViewportHeight: 176,
        });

        expect(resizeState.remeasureTargetHeight).toHaveBeenCalled();
    });

    it('reveals the current overlay when the previous overlay is still settling', async () => {
        vi.useFakeTimers();
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);
        await setup.handleToggleModelDropdownRequest();
        const oldMeasurement = deferred<void>();
        resizeState.remeasureTargetHeight.mockReturnValueOnce(oldMeasurement.promise);
        const position = {
            left: 12,
            top: 68,
            side: 'bottom' as const,
            requiredViewportHeight: null,
        };
        setup.handleOverlayPositioned(position);
        await flushPromises();

        await setup.openHistoryDialog();
        setup.handleOverlayPositioned(position);
        await vi.advanceTimersByTimeAsync(300);
        const currentOverlayRevealed = setup.overlayPositionReady;

        oldMeasurement.resolve();
        await vi.advanceTimersByTimeAsync(300);

        expect(currentOverlayRevealed).toBe(true);
        expect(setup.activeOverlay).toBe('session-history');
        expect(setup.overlayPositionReady).toBe(true);
    });

    it('user sees the reopened picker only after the viewport and native clipping region contain it', async () => {
        vi.useFakeTimers();
        let viewportHeight = 180;
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockImplementation(
            () => viewportHeight
        );
        const setup = getSetupState(mountSearchView());
        await setup.handleToggleModelDropdownRequest();
        const position = {
            left: 48,
            top: 161,
            side: 'bottom' as const,
            requiredViewportHeight: 553,
        };
        setup.handleOverlayPositioned(position);
        await vi.advanceTimersByTimeAsync(500);
        expect(setup.overlayPositionReady).toBe(false);

        const regionAccepted = deferred<boolean>();
        regionState.flush.mockReturnValueOnce(regionAccepted.promise);
        viewportHeight = 601;
        setup.handleOverlayPositioned(position);
        await vi.advanceTimersByTimeAsync(500);
        expect(setup.overlayPositionReady).toBe(false);

        regionAccepted.resolve(true);
        await vi.advanceTimersByTimeAsync(50);
        expect(setup.overlayPositionReady).toBe(true);
    });

    it('user can dismiss the picker while its native clipping region is still being prepared', async () => {
        vi.useFakeTimers();
        const regionAccepted = deferred<boolean>();
        regionState.flush.mockReturnValueOnce(regionAccepted.promise);
        const setup = getSetupState(mountSearchView());
        await setup.handleToggleModelDropdownRequest();
        setup.handleOverlayPositioned({
            left: 48,
            top: 161,
            side: 'bottom',
            requiredViewportHeight: null,
        });
        await vi.advanceTimersByTimeAsync(100);
        await setup.hideAllOverlays();
        regionAccepted.resolve(true);
        await vi.advanceTimersByTimeAsync(100);
        expect(setup.activeOverlay).toBe('none');
        expect(setup.overlayPositionReady).toBe(false);
    });

    it('user can open a picker in a stable native viewport without waiting for animation frames', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn(() => 1)
        );
        const setup = getSetupState(mountSearchView());
        await setup.handleToggleModelDropdownRequest();
        setup.handleOverlayPositioned({
            left: 48,
            top: 160,
            side: 'bottom',
            requiredViewportHeight: null,
        });
        for (let index = 0; index < 12; index += 1) await flushPromises();
        expect(setup.overlayPositionReady).toBe(true);
    });

    it.each(['fillConversationAvailableHeight', 'effectiveWindowMaximized'] as const)(
        'lets conversation content fill the available height when %s is active',
        async (mode) => {
            const setup = getSetupState(mountSearchView());
            expect(setup.pageContent.style.maxHeight).toBe('660px');
            setup[mode] = true;
            await nextTick();
            expect(setup.pageContent.style.maxHeight).toBe('none');
        }
    );

    it.each(['folding', 'resetting'] as const)(
        'keeps fresh QuickSearch results open when they arrive while %s',
        async (closeStage) => {
            const wrapper = mountSearchView();
            const setup = getSetupState(wrapper);
            Object.defineProperty(setup.pageContent, 'scrollHeight', { value: 300 });
            setup.handleQuickSearchOpenChange(true);
            await flushPromises();
            expect(setup.quickSearchRevealPhase).toBe('open');

            const oldClose = deferred<boolean>();
            if (closeStage === 'resetting')
                resizeState.collapseSessionToIdle.mockResolvedValueOnce(false);
            const pendingOperation =
                closeStage === 'folding'
                    ? resizeState.collapseSessionToIdle
                    : resizeState.resetSearchWindowBounds;
            pendingOperation.mockReturnValueOnce(oldClose.promise);
            setup.handleQuickSearchOpenChange(false);
            await flushPromises();
            await flushPromises();
            expect(pendingOperation).toHaveBeenCalledOnce();

            resizeState.remeasureTargetHeight.mockClear();
            setup.handleQuickSearchOpenChange(true);
            await flushPromises();
            expect(resizeState.remeasureTargetHeight).toHaveBeenCalled();
            oldClose.resolve(true);
            await flushPromises();
            await flushPromises();

            expect(setup.quickSearchOpen).toBe(true);
            expect(setup.quickSearchRevealPhase).toBe('open');

            // The cancelled close must not retain ownership of the next close.
            setup.handleQuickSearchOpenChange(false);
            await flushPromises();
            await flushPromises();
            expect(setup.quickSearchOpen).toBe(false);
        }
    );

    it('user keeps a reopened search when an earlier close is superseded', async () => {
        const setup = getSetupState(mountSearchView());
        setup.handleQuickSearchOpenChange(true);
        await flushPromises();
        const fold = deferred<boolean>();
        resizeState.collapseSessionToIdle.mockReturnValueOnce(fold.promise);
        setup.handleQuickSearchOpenChange(false);
        await flushPromises();
        setup.handleQuickSearchOpenChange(true);
        fold.resolve(false);
        await flushPromises();
        expect(resizeState.resetSearchWindowBounds).not.toHaveBeenCalled();
        expect(setup.quickSearchOpen).toBe(true);
    });

    it.each([true, false])(
        'user clears a conversation only after fallback geometry succeeds (%s)',
        async (accepted) => {
            const setup = getSetupState(mountSearchView());
            resizeState.collapseSessionToIdle.mockResolvedValueOnce(false);
            const reset = deferred<boolean>();
            resizeState.resetSearchWindowBounds.mockReturnValueOnce(reset.promise);
            const clear = setup.clearSessionToIdle();
            await flushPromises();
            expect(requestFlowState.current!.clearSession).not.toHaveBeenCalled();
            reset.resolve(accepted);
            await clear;
            expect(requestFlowState.current!.clearSession).toHaveBeenCalledTimes(accepted ? 1 : 0);
        }
    );

    it('user retains the results while a failed fold recovers its native bounds', async () => {
        const setup = getSetupState(mountSearchView());
        setup.handleQuickSearchOpenChange(true);
        await flushPromises();
        resizeState.collapseSessionToIdle.mockResolvedValueOnce(false);
        const reset = deferred<boolean>();
        resizeState.resetSearchWindowBounds.mockReturnValueOnce(reset.promise);
        setup.handleQuickSearchOpenChange(false);
        await flushPromises();
        expect(setup.quickSearchOpen).toBe(true);
        expect(setup.quickSearchRevealPhase).toBe('folding');
        reset.resolve(false);
        await flushPromises();
        expect(setup.quickSearchOpen).toBe(true);
        expect(setup.quickSearchRevealPhase).toBe('open');
    });

    it('user can reveal arrived QuickSearch results without waiting for a rendering frame', async () => {
        vi.useFakeTimers();
        const setup = getSetupState(mountSearchView());
        setup.handleQuickSearchOpenChange(true);
        await flushPromises();
        expect(setup.quickSearchRevealPhase).toBe('open');
        expect(resizeState.remeasureTargetHeight).toHaveBeenCalled();
    });

    it('user cannot restart native resizing through a picker while the surface is hidden', async () => {
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);
        const onSurfaceHidden = lifecycleState.options?.onSurfaceHidden as () => Promise<void>;

        await onSurfaceHidden();
        expect(resizeState.options?.resizeEnabled?.value).toBe(false);

        await setup.handleToggleModelDropdownRequest();

        expect(setup.activeOverlay).toBe('none');
        expect(resizeState.options?.resizeEnabled?.value).toBe(false);

        (lifecycleState.options!.onSurfaceVisibilityChange as (visible: boolean) => void)(true);
        await setup.handleToggleModelDropdownRequest();
        expect(setup.activeOverlay).toBe('model-dropdown');
        expect(resizeState.options?.resizeEnabled?.value).toBe(true);
    });

    it('keeps a newer history intent when an older model load resolves late', async () => {
        const modelLoad = deferred<void>();
        controllerMock.prepareModelDropdownOpen.mockReturnValueOnce(modelLoad.promise);
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);

        const openModel = setup.handleToggleModelDropdownRequest();
        await flushPromises();
        expect(controllerMock.prepareModelDropdownOpen).toHaveBeenCalledTimes(1);

        await setup.openHistoryDialog();
        expect(setup.activeOverlay).toBe('session-history');
        expect(requestFlowState.current?.sessionHistoryOverlayOpen.value).toBe(true);

        modelLoad.resolve();
        await openModel;

        expect(setup.activeOverlay).toBe('session-history');
        expect(setup.renderedOverlay).toBe('session-history');
        expect(setup.modelDropdownState).toEqual({ isOpen: false });
        expect(requestFlowState.current?.sessionHistoryOverlayOpen.value).toBe(true);
    });

    it('cancels shortcut auto-paste when the surface hides during clipboard consumption', async () => {
        const clipboardRead = deferred<{
            snapshotId: string;
            observedAt: number;
            text: string;
            imagePaths: string[];
            filePaths: string[];
        }>();
        clipboardState.consumeShortcutAutoPastePayload.mockReturnValueOnce(clipboardRead.promise);

        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);
        const interactionContext = setup.searchInteractionContext;
        interactionContext.markWindowHidden({
            hideReason: 'manual-dismiss',
            hiddenAt: Date.now(),
        });
        interactionContext.recordActivation('shortcut');

        const autoPaste = setup.tryShortcutAutoPaste();
        await flushPromises();
        expect(clipboardState.consumeShortcutAutoPastePayload).toHaveBeenCalledOnce();

        interactionContext.markWindowHidden({
            hideReason: 'manual-dismiss',
            hiddenAt: Date.now(),
        });
        clipboardRead.resolve({
            snapshotId: 'snapshot-1',
            observedAt: Date.now(),
            text: 'late clipboard text',
            imagePaths: [],
            filePaths: [],
        });
        await autoPaste;

        expect(draftState.importClipboardPayload).not.toHaveBeenCalled();

        clipboardState.consumeShortcutAutoPastePayload.mockResolvedValueOnce({
            snapshotId: 'snapshot-2',
            observedAt: Date.now(),
            text: 'fresh clipboard text',
            imagePaths: [],
            filePaths: [],
        });
        interactionContext.recordActivation('shortcut');
        await setup.tryShortcutAutoPaste();

        expect(draftState.importClipboardPayload).toHaveBeenCalledTimes(1);
        expect(draftState.importClipboardPayload).toHaveBeenCalledWith(
            expect.objectContaining({ snapshotId: 'snapshot-2' }),
            { trimTextBoundary: true }
        );
    });

    it('cancels a pending model open when a newer toggle arrives before loading finishes', async () => {
        const modelLoad = deferred<void>();
        controllerMock.prepareModelDropdownOpen.mockReturnValueOnce(modelLoad.promise);
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);

        const firstToggle = setup.handleToggleModelDropdownRequest();
        await flushPromises();
        const secondToggle = setup.handleToggleModelDropdownRequest();
        await secondToggle;

        expect(controllerMock.prepareModelDropdownOpen).toHaveBeenCalledTimes(1);
        expect(setup.activeOverlay).toBe('none');
        expect(setup.modelDropdownState).toEqual({ isOpen: false });

        modelLoad.resolve();
        await firstToggle;

        expect(setup.activeOverlay).toBe('none');
        expect(setup.renderedOverlay).toBe('none');
        expect(setup.modelDropdownState).toEqual({ isOpen: false });
        expect(requestFlowState.current?.sessionHistoryOverlayOpen.value).toBe(false);
    });

    it('keeps a newer hide intent when an older model load resolves late', async () => {
        const modelLoad = deferred<void>();
        controllerMock.prepareModelDropdownOpen.mockReturnValueOnce(modelLoad.promise);
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);

        const openModel = setup.handleToggleModelDropdownRequest();
        await flushPromises();
        await setup.hideAllOverlays(false);

        modelLoad.resolve();
        await openModel;

        expect(setup.activeOverlay).toBe('none');
        expect(setup.renderedOverlay).toBe('none');
        expect(setup.modelDropdownState).toEqual({ isOpen: false });
        expect(requestFlowState.current?.sessionHistoryOverlayOpen.value).toBe(false);
    });

    it('invalidates a pending model load when the keyboard hide starts', async () => {
        const modelLoad = deferred<void>();
        controllerMock.prepareModelDropdownOpen.mockReturnValueOnce(modelLoad.promise);
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);
        const openModel = setup.handleToggleModelDropdownRequest();
        await flushPromises();

        const hideFromKeyboard = keyboardState.options?.hideSearchWindow;
        expect(hideFromKeyboard).toBeDefined();
        await hideFromKeyboard?.();
        expect(lifecycleState.hideSearchWindow).toHaveBeenCalledTimes(1);

        modelLoad.resolve();
        await openModel;

        expect(setup.activeOverlay).toBe('none');
        expect(setup.renderedOverlay).toBe('none');
        expect(setup.modelDropdownState).toEqual({ isOpen: false });
    });

    it('propagates lifecycle hide errors through the keyboard hide handler', async () => {
        const hideError = new Error('hide failed');
        lifecycleState.hideSearchWindow.mockRejectedValueOnce(hideError);
        mountSearchView();

        await expect(keyboardState.options?.hideSearchWindow()).rejects.toBe(hideError);
    });

    it('keeps a newer history intent when an older model selection resolves late', async () => {
        const modelSelection = deferred<{ modelId: string; providerId: number }>();
        controllerMock.selectModelFromDropdown.mockReturnValueOnce(modelSelection.promise);
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);
        await setup.handleToggleModelDropdownRequest();
        controllerMock.focusSearchInput.mockClear();

        const selectModel = setup.handleModelSelect(7);
        await flushPromises();
        await setup.openHistoryDialog();

        modelSelection.resolve({ modelId: 'late-model', providerId: 9 });
        await selectModel;

        expect(setup.activeOverlay).toBe('session-history');
        expect(setup.modelOverride).toEqual({ modelId: null, providerId: null });
        expect(controllerMock.focusSearchInput).not.toHaveBeenCalled();
    });

    it('invalidates an in-flight overlay intent when the view unmounts', async () => {
        const modelLoad = deferred<void>();
        controllerMock.prepareModelDropdownOpen.mockReturnValueOnce(modelLoad.promise);
        const wrapper = mountSearchView();
        const setup = getSetupState(wrapper);
        const openModel = setup.handleToggleModelDropdownRequest();
        await flushPromises();

        wrapper.unmount();
        wrappers.splice(wrappers.indexOf(wrapper), 1);
        modelLoad.resolve();
        await openModel;

        expect(controllerMock.getModelDropdownAnchor).not.toHaveBeenCalled();
        expect(setup.activeOverlay).toBe('none');
        expect(setup.modelDropdownState).toEqual({ isOpen: false });
    });

    it('user can show the search surface when native borders differ from the prepared client viewport', async () => {
        mountSearchView();
        const viewport = await surfacePreparationState.options!.getViewport();
        expect(viewport).toEqual({
            physicalViewport: { x: 100, y: 200, width: 750, height: 60 },
            scaleFactor: 1,
        });
    });

    it('does not install the E2E bridge when unmount cancels the initial native commit', async () => {
        const initialCommit = deferred<boolean>();
        runtimeModeState.isE2eTestMode.mockResolvedValue(true);
        surfacePreparationState.start.mockReturnValueOnce(initialCommit.promise);
        surfacePreparationState.dispose.mockImplementationOnce(() => {
            initialCommit.resolve(false);
        });
        const wrapper = mountSearchView();

        await flushPromises();
        expect(surfacePreparationState.start).toHaveBeenCalledOnce();
        expect((window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__).toBeUndefined();

        wrapper.unmount();
        wrappers.splice(wrappers.indexOf(wrapper), 1);
        await flushPromises();

        expect(surfacePreparationState.dispose).toHaveBeenCalledOnce();
        expect((window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__).toBeUndefined();
    });

    it('does not install the E2E bridge when first-paint initialization fails', async () => {
        runtimeModeState.isE2eTestMode.mockResolvedValue(true);
        startupState.initialize.mockImplementationOnce(async (options) => options.onReady(false));
        mountSearchView();

        await flushPromises();
        await flushPromises();

        expect(surfacePreparationState.start).not.toHaveBeenCalled();
        expect(runtimeModeState.isE2eTestMode).not.toHaveBeenCalled();
        expect((window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__).toBeUndefined();
    });

    it('installs the E2E bridge only after the initial native commit succeeds', async () => {
        const initialCommit = deferred<boolean>();
        runtimeModeState.isE2eTestMode.mockResolvedValue(true);
        surfacePreparationState.start.mockReturnValueOnce(initialCommit.promise);
        mountSearchView();

        await flushPromises();
        expect(surfacePreparationState.start).toHaveBeenCalledOnce();
        expect(runtimeModeState.isE2eTestMode).not.toHaveBeenCalled();
        expect((window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__).toBeUndefined();

        initialCommit.resolve(true);
        await flushPromises();

        expect(runtimeModeState.isE2eTestMode).toHaveBeenCalledOnce();
        expect((window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__).toBeDefined();
    });

    it('user can supply deterministic search results through the ready E2E bridge', async () => {
        runtimeModeState.isE2eTestMode.mockResolvedValue(true);
        mountSearchView();
        await flushPromises();
        await flushPromises();

        const bridge = (
            window as Window & {
                __TOUCHAI_E2E__?: {
                    setSearchFixture: (query: string, results: unknown[]) => void;
                    getQuickSearchFallbackResults: (query: string) => unknown[];
                };
            }
        ).__TOUCHAI_E2E__!;
        expect(bridge.getQuickSearchFallbackResults('touchai')).toEqual([]);
        const results = [{ name: 'Fixture', path: 'D:/fixture.txt', source: 'file' }];
        bridge.setSearchFixture('Fixture', results);
        expect(bridge.getQuickSearchFallbackResults(' fixture ')).toEqual(results);
        expect(bridge.getQuickSearchFallbackResults('another query')).toEqual([]);
    });

    it('user resets the E2E draft through the same complete clear flow as the product', async () => {
        runtimeModeState.isE2eTestMode.mockResolvedValue(true);
        mountSearchView();
        await flushPromises();
        await flushPromises();

        const bridge = (
            window as Window & {
                __TOUCHAI_E2E__?: {
                    resetDraft: () => void;
                };
            }
        ).__TOUCHAI_E2E__!;
        bridge.resetDraft();

        expect(draftState.clearDraft).toHaveBeenCalledOnce();
    });

    it('user submitting from idle waits for response content before the window expands', async () => {
        mountSearchView();

        const submit = keyboardState.options?.handleSubmit;
        expect(submit).toEqual(expect.any(Function));

        await submit?.('hello from idle bar');
        await flushPromises();

        expect(requestFlowState.current?.handleSubmit).toHaveBeenCalledWith('hello from idle bar');
        expect(resizeState.playSessionExpandAnimation).not.toHaveBeenCalled();
    });

    it('user sees a submitted conversation expand when content mounts without waiting for animation frames', async () => {
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn(() => 1)
        );
        mountSearchView();
        const request = deferred<void>();
        requestFlowState.current!.handleSubmit.mockReturnValueOnce(request.promise);
        const submit = keyboardState.options!.handleSubmit!('hello');
        await flushPromises();
        expect(resizeState.playSessionExpandAnimation).not.toHaveBeenCalled();

        requestFlowState.current!.sessionHistory.value = [
            { id: 'first', role: 'user', content: 'hello' } as SessionMessage,
        ];
        for (let tick = 0; tick < 12; tick += 1) await flushPromises();

        expect(resizeState.playSessionExpandAnimation).toHaveBeenCalledWith(400);
        request.resolve();
        await submit;
    });

    it.each(['hide', 'unmount'] as const)(
        'user does not get a late expansion when %s cancels a pending content mount',
        async (action) => {
            vi.stubGlobal(
                'requestAnimationFrame',
                vi.fn(() => 1)
            );
            const wrapper = mountSearchView();
            const setup = getSetupState(wrapper);
            const request = deferred<void>();
            requestFlowState.current!.handleSubmit.mockReturnValueOnce(request.promise);
            const submit = keyboardState.options!.handleSubmit!('hello');
            await flushPromises();
            if (action === 'hide') await keyboardState.options!.hideSearchWindow();
            else {
                wrapper.unmount();
                wrappers.splice(wrappers.indexOf(wrapper), 1);
            }
            requestFlowState.current!.sessionHistory.value = [
                { id: 'first', role: 'user', content: 'hello' } as SessionMessage,
            ];
            request.resolve();
            for (let tick = 0; tick < 12; tick += 1) await flushPromises();

            expect(setup.surfaceMeasurementHold).toBe(false);
            expect(resizeState.playSessionExpandAnimation).not.toHaveBeenCalled();
            await submit;
        }
    );

    it('user keeps QuickSearch results until the actual handoff animation finishes', async () => {
        vi.useFakeTimers();
        const animation = deferred<void>();
        vi.stubGlobal(
            'requestAnimationFrame',
            vi.fn(() => 1)
        );
        const original = HTMLElement.prototype.getAnimations;
        HTMLElement.prototype.getAnimations = () => [
            {
                finished: animation.promise,
                cancel: () => animation.resolve(),
            } as unknown as Animation,
        ];
        try {
            const setup = getSetupState(mountSearchView());
            setup.handleQuickSearchOpenChange(true);
            await flushPromises();
            requestFlowState.current!.handleSubmit.mockImplementationOnce(async () => {
                requestFlowState.current!.sessionHistory.value = [
                    { id: 'first', role: 'user', content: 'hello' } as SessionMessage,
                ];
            });
            const submit = keyboardState.options!.handleSubmit!('hello');
            await vi.advanceTimersByTimeAsync(1000);
            expect(setup.quickSearchOpen).toBe(true);
            animation.resolve();
            await submit;
            expect(setup.quickSearchOpen).toBe(false);
        } finally {
            HTMLElement.prototype.getAnimations = original;
        }
    });

    it('user hiding the window before a history selection opens releases that selection', async () => {
        const setup = getSetupState(mountSearchView());
        const selection = { interaction: Promise.resolve({}), resultCount: 1 };
        requestFlowState.current!.markHistorySelectionPending.mockReturnValueOnce(selection);
        const opening = setup.handleOpenSession(1, 'history');
        await keyboardState.options!.hideSearchWindow();
        await opening;

        expect(requestFlowState.current!.openSession).not.toHaveBeenCalled();
        expect(requestFlowState.current!.abandonHistorySelection).toHaveBeenCalledWith(selection);
        expect(setup.surfaceMeasurementHold).toBe(false);
    });

    it('does not install the E2E bridge when unmount wins a pending mode check', async () => {
        const modeCheck = deferred<boolean>();
        runtimeModeState.isE2eTestMode.mockReturnValueOnce(modeCheck.promise);
        const wrapper = mountSearchView();

        await flushPromises();
        await flushPromises();
        expect(surfacePreparationState.start).toHaveBeenCalledOnce();
        expect(runtimeModeState.isE2eTestMode).toHaveBeenCalledOnce();

        wrapper.unmount();
        wrappers.splice(wrappers.indexOf(wrapper), 1);
        modeCheck.resolve(true);
        await flushPromises();

        expect((window as Window & { __TOUCHAI_E2E__?: unknown }).__TOUCHAI_E2E__).toBeUndefined();
    });
});
