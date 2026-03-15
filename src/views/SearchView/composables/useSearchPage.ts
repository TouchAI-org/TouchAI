/**
 * SearchView 页面层。
 * 集中管理页面控制器、生命周期编排与键盘输入路由，避免页面逻辑零散分布。
 */
import type { ConversationMessage } from '@composables/useAgent';
import { useAlert } from '@composables/useAlert';
import { useWindowResize } from '@composables/useWindowResize';
import { native } from '@services/NativeService';
import type { ModelDropdownData, ModelDropdownPopupItem } from '@services/PopupService';
import { popupManager } from '@services/PopupService';
import { runStartupTasks } from '@services/StartupService';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { sendNotification } from '@tauri-apps/plugin-notification';
import {
    computed,
    type ComputedRef,
    nextTick,
    onMounted,
    onUnmounted,
    type Ref,
    ref,
    watch,
} from 'vue';

import { useSettingsStore } from '@/stores/settings';

import type {
    ConversationPanelHandle,
    PendingRequest,
    QuickSearchHandle,
    SearchBarHandle,
    SearchCursorContext,
    SearchModelDropdownContext,
    SearchModelDropdownState,
    SearchModelOverride,
    SearchOverlayState,
    SearchPageController,
} from '../types';
import { useModelDropdownPopup } from './useModelDropdownPopup';

const DOUBLE_BACKSPACE_INTERVAL = 300;
const WINDOW_MAX_HEIGHT = 700;
const HIDE_TIMEOUT_MS = 5 * 60 * 1000;
type SearchOverlayCommand =
    | 'noop'
    | 'close-quick-search'
    | 'wait-layout-stable'
    | 'open-model-dropdown';

function createEmptyModelOverride(): SearchModelOverride {
    return {
        modelId: null,
        providerId: null,
    };
}

function mapPopupModel(
    model: SearchModelDropdownContext['models'][number]
): ModelDropdownPopupItem {
    return {
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
    };
}

/**
 * 搜索页子组件命令适配层。
 * 负责把 SearchBar / QuickSearchPanel / ConversationPanel 的 exposed API
 * 收口成页面动作接口，避免页面级 composable 直接依赖子组件命令细节。
 *
 * @param options 搜索页子组件句柄。
 * @returns 页面动作 controller。
 */
export function useSearchPageController(options: {
    searchBar: Ref<SearchBarHandle | undefined>;
    quickSearchOpen: Ref<boolean>;
    quickSearchPanel: Ref<QuickSearchHandle | undefined>;
    conversationPanel: Ref<ConversationPanelHandle | undefined>;
}): SearchPageController {
    const { searchBar, quickSearchOpen, quickSearchPanel, conversationPanel } = options;

    function focusConversation() {
        conversationPanel.value?.focus();
    }

    async function focusSearchInput() {
        await searchBar.value?.focus();
    }

    async function loadActiveModel() {
        await searchBar.value?.loadActiveModel();
    }

    async function prepareModelDropdownOpen() {
        await searchBar.value?.prepareModelDropdownOpen();
    }

    function resetModelDropdownState() {
        searchBar.value?.resetModelDropdownState();
    }

    async function selectModelFromDropdown(modelDbId: number) {
        return (
            (await searchBar.value?.selectModelFromDropdown(modelDbId)) ?? {
                modelId: null,
                providerId: null,
            }
        );
    }

    function getModelDropdownAnchor() {
        return searchBar.value?.getModelDropdownAnchor() ?? null;
    }

    function getModelDropdownContext() {
        return (
            searchBar.value?.getModelDropdownContext() ?? {
                activeModelId: null,
                activeProviderId: null,
                selectedModelId: null,
                selectedProviderId: null,
                searchQuery: '',
                models: [],
            }
        );
    }

    function isQuickSearchOpen() {
        return quickSearchOpen.value;
    }

    function isQuickSearchItemHighlighted() {
        return quickSearchPanel.value?.getHighlightedItem() !== null;
    }

    function openQuickSearch() {
        quickSearchPanel.value?.open();
    }

    function closeQuickSearch() {
        const wasOpen = quickSearchOpen.value;
        quickSearchOpen.value = false;
        if (!wasOpen) {
            // 页面可能在“结果尚未返回、面板尚未真正显示”阶段就判定需要关闭；
            // 这里主动同步关闭态，避免旧异步结果回流后再次把面板打开。
            quickSearchPanel.value?.syncClosedState();
        }
    }

    function moveQuickSearchSelection(direction: 'up' | 'down' | 'left' | 'right') {
        quickSearchPanel.value?.moveSelection(direction);
    }

    async function openHighlightedQuickSearchItem() {
        await quickSearchPanel.value?.openHighlightedItem();
    }

    function triggerQuickSearch(query: string) {
        quickSearchPanel.value?.triggerSearch(query);
    }

    return {
        focusConversation,
        focusSearchInput,
        loadActiveModel,
        prepareModelDropdownOpen,
        resetModelDropdownState,
        selectModelFromDropdown,
        getModelDropdownAnchor,
        getModelDropdownContext,
        isQuickSearchOpen,
        isQuickSearchItemHighlighted,
        openQuickSearch,
        closeQuickSearch,
        moveQuickSearchSelection,
        openHighlightedQuickSearchItem,
        triggerQuickSearch,
    };
}

interface UseSearchPanelFocusRestoreOptions {
    controller: SearchPageController;
}

/**
 * 搜索页面板点击回焦策略。
 * 负责把“点击会话/QuickSearch 非交互区域后回到搜索框”的规则集中到页面层，
 * 避免模板组件承载浏览器选区时序与交互元素白名单等细节。
 *
 * @param options 页面 controller。
 * @returns 面板表面点击处理器。
 */
export function useSearchPanelFocusRestore(options: UseSearchPanelFocusRestoreOptions) {
    const { controller } = options;

    function shouldKeepPanelClickFocus(target: HTMLElement | null): boolean {
        if (!target) {
            return false;
        }

        return Boolean(
            target.closest(
                [
                    'a',
                    'button',
                    'input',
                    'textarea',
                    'select',
                    'summary',
                    '[role="button"]',
                    '[contenteditable="true"]',
                    '[data-drag-exclude="true"]',
                ].join(', ')
            )
        );
    }

    function hasActiveTextSelection() {
        const selection = window.getSelection();
        return Boolean(
            selection && !selection.isCollapsed && selection.toString().trim().length > 0
        );
    }

    /**
     * 选中文本后首次点击空白区域时，浏览器会先清理原有选区，
     * 因此需要延后一帧再判断，才能把“清选区”和“回焦输入框”
     * 合并到同一次点击里，而不是要求用户点击两次。
     */
    function restoreSearchFocusAfterSelectionClears() {
        requestAnimationFrame(() => {
            if (hasActiveTextSelection()) {
                return;
            }

            void controller.focusSearchInput();
        });
    }

    /**
     * 点击结果/会话面板的非交互区域后，把输入焦点还给搜索框，
     * 让用户能继续直接键入，同时不打断按钮点击或文本选区操作。
     *
     * @param event 面板 click 事件。
     * @returns void
     */
    function handlePanelSurfaceClick(event: MouseEvent) {
        const target = event.target as HTMLElement | null;

        if (event.defaultPrevented || shouldKeepPanelClickFocus(target)) {
            return;
        }

        if (hasActiveTextSelection()) {
            restoreSearchFocusAfterSelectionClears();
            return;
        }

        void controller.focusSearchInput();
    }

    return {
        handlePanelSurfaceClick,
    };
}

interface UseSearchPageLifecycleOptions {
    pageContainer: Ref<HTMLElement | null>;
    controller: SearchPageController;
    viewReady: Ref<boolean>;
    isDragging: Ref<boolean>;
    isPinned: Ref<boolean>;
    conversationHistory: Ref<ConversationMessage[]>;
    clearConversation: () => void;
}

/**
 * 搜索页生命周期编排。
 * 负责窗口聚焦/失焦、超时清理、全局快捷键和页面级初始化逻辑，
 * 将这些系统副作用从 SearchView 模板组件中拆离。
 *
 * @param options 页面状态与系统级回调/页面动作接口。
 * @returns 生命周期相关状态。
 */
export function useSearchPageLifecycle(options: UseSearchPageLifecycleOptions) {
    const {
        pageContainer,
        controller,
        viewReady,
        isDragging,
        isPinned,
        conversationHistory,
        clearConversation,
    } = options;

    const isDevBlurHideSuspended = ref(false);
    const isDevMode = import.meta.env.DEV;
    const settingsStore = useSettingsStore();

    let unlistenFocus: (() => void) | null = null;
    let unlistenBlur: (() => void) | null = null;
    let unlistenPopupFocusMain: (() => void) | null = null;
    let stopReadyWatch: (() => void) | null = null;
    let lastHideTime: number | null = null;
    let lifecycleInitialized = false;

    useWindowResize({ target: pageContainer, maxHeight: WINDOW_MAX_HEIGHT });

    const shouldHideOnBlur = computed(() => {
        if (isDragging.value) return false;
        if (isDevMode && isDevBlurHideSuspended.value) return false;
        return !(isPinned.value && conversationHistory.value.length > 0);
    });

    function recordHideTime() {
        lastHideTime = Date.now();
    }

    function checkAndClearIfTimeout() {
        if (lastHideTime === null) return;
        if (Date.now() - lastHideTime >= HIDE_TIMEOUT_MS) {
            clearConversation();
            lastHideTime = null;
        }
    }

    async function handleWindowBlur() {
        try {
            const appFocused = await native.window.isAppFocused();
            if (!appFocused) {
                // App 失焦时总是关闭所有弹窗，避免遗留浮层。
                await popupManager.hide();

                if (shouldHideOnBlur.value) {
                    recordHideTime();
                    await native.window.hideSearchWindow();
                }
            }
        } catch (error) {
            console.error('[SearchView] Failed to handle window blur:', error);
        }
    }

    async function initializeGlobalShortcut() {
        try {
            await settingsStore.initialize();
            await native.shortcut.registerGlobalShortcut(settingsStore.globalShortcut);
        } catch (error) {
            console.error('[SearchView] Failed to initialize global shortcut:', error);

            // 把平台错误文本映射为面向用户的提示，避免暴露内部细节。
            const errorStr = String(error);
            let message = '注册快捷键失败';

            if (errorStr.includes('already registered') || errorStr.includes('已注册')) {
                message = '快捷键已被其他应用占用，请在设置中更换';
            } else if (errorStr.includes('invalid') || errorStr.includes('无效')) {
                message = '快捷键格式无效，请在设置中重新配置';
            } else if (errorStr.includes('Unknown key')) {
                message = '不支持的按键，请在设置中更换';
            }

            sendNotification({
                title: 'TouchAI - 快捷键注册失败',
                body: message,
            });
        }
    }

    async function initializeSearchView() {
        try {
            await initializeGlobalShortcut();
            useAlert();
            await popupManager.initialize();
        } catch (error) {
            console.error('[SearchView] Failed to initialize:', error);
        }
    }

    async function startLifecycleOnceReady() {
        if (lifecycleInitialized || !viewReady.value) {
            return;
        }

        lifecycleInitialized = true;
        await initializeSearchView();
        await initFocusListener();
        await runStartupTasks();
    }

    async function initFocusListener() {
        unlistenFocus = await getCurrentWindow().listen('tauri://focus', async () => {
            checkAndClearIfTimeout();

            await nextTick();
            await controller.focusSearchInput();
            await controller.loadActiveModel();
        });

        unlistenBlur = await getCurrentWindow().listen('tauri://blur', async () => {
            await handleWindowBlur();
        });

        unlistenPopupFocusMain = await listen('popup-focus-main', async () => {
            await getCurrentWindow().setFocus();
            setTimeout(() => {
                void controller.focusSearchInput();
            }, 50);
        });
    }

    onMounted(() => {
        if (viewReady.value) {
            void startLifecycleOnceReady();
            return;
        }

        stopReadyWatch = watch(
            viewReady,
            (ready) => {
                if (!ready) {
                    return;
                }

                stopReadyWatch?.();
                stopReadyWatch = null;
                void startLifecycleOnceReady();
            },
            { flush: 'post' }
        );
    });

    onUnmounted(() => {
        stopReadyWatch?.();
        stopReadyWatch = null;
        unlistenFocus?.();
        unlistenFocus = null;
        unlistenBlur?.();
        unlistenBlur = null;
        unlistenPopupFocusMain?.();
        unlistenPopupFocusMain = null;
    });

    return {
        isDevMode,
        isDevBlurHideSuspended,
    };
}

interface UseSearchOverlayMachineOptions {
    isQuickSearchOpen: ComputedRef<boolean>;
    modelDropdownState: Ref<SearchModelDropdownState>;
}

/**
 * 搜索页浮层状态机。
 * 负责QuickSearch 与模型下拉等各类模块状态切换过程。
 *
 * @param options QuickSearch 与模型下拉可见性状态。
 * @returns 当前浮层阶段、状态迁移方法与 machine 生成的副作用命令。
 */
export function useSearchOverlayMachine(options: UseSearchOverlayMachineOptions) {
    const { isQuickSearchOpen, modelDropdownState } = options;
    const overlayState = ref<SearchOverlayState>('idle');

    function syncOverlayState() {
        if (
            overlayState.value === 'model-dropdown-preparing' ||
            overlayState.value === 'waiting-layout-stable'
        ) {
            return;
        }

        if (modelDropdownState.value.isOpen) {
            overlayState.value = 'model-dropdown-open';
            return;
        }

        overlayState.value = isQuickSearchOpen.value ? 'quick-search-open' : 'idle';
    }

    function requestModelDropdownOpen(): SearchOverlayCommand {
        if (
            modelDropdownState.value.isOpen ||
            overlayState.value === 'model-dropdown-preparing' ||
            overlayState.value === 'waiting-layout-stable'
        ) {
            return 'noop';
        }

        overlayState.value = 'model-dropdown-preparing';
        return isQuickSearchOpen.value ? 'close-quick-search' : 'open-model-dropdown';
    }

    function handleQuickSearchClosedForModelDropdown(): SearchOverlayCommand {
        if (overlayState.value !== 'model-dropdown-preparing') {
            return 'noop';
        }

        overlayState.value = 'waiting-layout-stable';
        return 'wait-layout-stable';
    }

    function handleLayoutStableForModelDropdown(): SearchOverlayCommand {
        if (overlayState.value !== 'waiting-layout-stable') {
            return 'noop';
        }

        return 'open-model-dropdown';
    }

    function handleModelDropdownOpened() {
        overlayState.value = 'model-dropdown-open';
    }

    function handleModelDropdownClosed() {
        syncOverlayState();
    }

    watch(
        () => [isQuickSearchOpen.value, modelDropdownState.value.isOpen],
        () => {
            syncOverlayState();
        },
        { immediate: true, flush: 'sync' }
    );

    return {
        overlayState,
        requestModelDropdownOpen,
        handleQuickSearchClosedForModelDropdown,
        handleLayoutStableForModelDropdown,
        handleModelDropdownOpened,
        handleModelDropdownClosed,
        syncOverlayState,
    };
}

interface UseSearchKeyboardOptions {
    viewReady: Ref<boolean>;
    queryText: Ref<string>;
    cursorContext: Ref<SearchCursorContext>;
    modelOverride: Ref<SearchModelOverride>;
    modelDropdownState: Ref<SearchModelDropdownState>;
    controller: SearchPageController;
    conversationHistory: Ref<ConversationMessage[]>;
    pendingRequest: Ref<PendingRequest | null>;
    isWaitingForCompletion: Ref<boolean>;
    isLoading: Ref<boolean>;
    isQuickSearchOpen: ComputedRef<boolean>;
    isDevMode: boolean;
    isDevBlurHideSuspended: Ref<boolean>;
    shouldTriggerQuickSearch: (query: string) => boolean;
    hideAllDropdowns: () => Promise<void>;
    closeModelDropdown: () => Promise<void>;
    openModelDropdown: () => Promise<void>;
    handleSubmit: (query: string) => Promise<void>;
    clearAll: () => void;
    cancelRequest: () => void;
    clearConversation: () => void;
}

interface UseSearchModelDropdownCoordinatorOptions {
    pageContainer: Ref<HTMLElement | null>;
    controller: SearchPageController;
    modelOverride: Ref<SearchModelOverride>;
    modelDropdownState: Ref<SearchModelDropdownState>;
    requestModelDropdownOpen: () => SearchOverlayCommand;
    handleQuickSearchClosedForModelDropdown: () => SearchOverlayCommand;
    handleLayoutStableForModelDropdown: () => SearchOverlayCommand;
    handleModelDropdownOpened: () => void;
    handleModelDropdownClosed: () => void;
    syncOverlayState: () => void;
}

/**
 * 搜索页模型下拉编排层。
 * 负责协调 QuickSearch 收敛、布局稳定与模型下拉打开时序。
 *
 * @param options 页面容器、controller 与 SearchBar 状态。
 * @returns 模型下拉打开/切换的编排方法。
 */
export function useSearchModelDropdownCoordinator(
    options: UseSearchModelDropdownCoordinatorOptions
) {
    const {
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
    } = options;

    function getPopupData(): ModelDropdownData {
        const context = controller.getModelDropdownContext();
        return {
            activeModelId: context.activeModelId ?? '',
            activeProviderId: context.activeProviderId,
            selectedModelId: context.selectedModelId ?? '',
            selectedProviderId: context.selectedProviderId,
            searchQuery: context.searchQuery,
            models: context.models
                .filter((model) => model.provider_enabled === 1)
                .map(mapPopupModel),
        };
    }

    const dropdownPopup = useModelDropdownPopup({
        getAnchorElement: controller.getModelDropdownAnchor,
        getPopupData,
        isModelDropdownActive: () => modelDropdownState.value.isOpen,
        onModelSelect: async (modelDbId) => {
            modelOverride.value = await controller.selectModelFromDropdown(modelDbId);
            await dropdownPopup.close();
        },
        onClose: () => {
            controller.resetModelDropdownState();
            handleModelDropdownClosed();
        },
    });

    /**
     * 关闭 QuickSearch 后等待布局稳定，避免弹窗用旧几何信息定位。
     */
    async function waitForLayoutStable() {
        const el = pageContainer.value;
        if (!el) {
            return;
        }

        const maxWaitMs = 200;
        const stableFramesRequired = 2;
        const heightThreshold = 0.5;
        const start = performance.now();
        let stableFrames = 0;
        let lastHeight = el.getBoundingClientRect().height;

        while (performance.now() - start < maxWaitMs) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const currentHeight = el.getBoundingClientRect().height;
            if (Math.abs(currentHeight - lastHeight) <= heightThreshold) {
                stableFrames += 1;
                if (stableFrames >= stableFramesRequired) {
                    return;
                }
            } else {
                stableFrames = 0;
                lastHeight = currentHeight;
            }
        }
    }

    /**
     * 按 overlay machine 给出的命令顺序执行模型下拉打开流程。
     * 这里故意使用小步 command loop，而不是把所有判断重新写回 coordinator，
     * 这样“何时关 QuickSearch / 何时等布局 / 何时开 dropdown”的决策仍由 machine 主导。
     */
    async function runModelDropdownOpenSequence(initialCommand: SearchOverlayCommand) {
        let command = initialCommand;

        while (command !== 'noop') {
            if (command === 'close-quick-search') {
                controller.closeQuickSearch();
                await nextTick();
                command = handleQuickSearchClosedForModelDropdown();
                continue;
            }

            if (command === 'wait-layout-stable') {
                await waitForLayoutStable();
                command = handleLayoutStableForModelDropdown();
                continue;
            }

            if (command === 'open-model-dropdown') {
                try {
                    await controller.prepareModelDropdownOpen();
                    await dropdownPopup.open();
                    handleModelDropdownOpened();
                } catch (error) {
                    controller.resetModelDropdownState();
                    syncOverlayState();
                    console.error('[SearchView] Failed to open model dropdown popup:', error);
                }
                return;
            }
        }
    }

    // 确保模型下拉在 QuickSearch 收敛与布局稳定之后再打开，避免定位使用旧尺寸。
    async function openModelDropdownWithLayoutSync() {
        const command = requestModelDropdownOpen();
        if (command === 'noop') {
            return;
        }

        await runModelDropdownOpenSequence(command);
    }

    /**
     * 关闭模型下拉的页面级策略。
     * 先关闭 popup，再回收模型搜索会话，避免领域状态与浮层可见性错位。
     *
     * @returns Promise<void>
     */
    async function closeModelDropdown() {
        try {
            await dropdownPopup.close();
        } finally {
            controller.resetModelDropdownState();
            handleModelDropdownClosed();
        }
    }

    /**
     * 统一收敛页面中的 dropdown 状态。
     *
     * @returns Promise<void>
     */
    async function hideAllDropdowns() {
        if (!modelDropdownState.value.isOpen) {
            return;
        }

        await closeModelDropdown();
    }

    // 将模型下拉开关集中到页面层，避免 SearchBar 与 QuickSearch 互相控制。
    async function handleToggleModelDropdownRequest() {
        if (modelDropdownState.value.isOpen) {
            await closeModelDropdown();
            return;
        }

        await openModelDropdownWithLayoutSync();
    }

    watch(
        () => [modelDropdownState.value.isOpen, modelDropdownState.value.query],
        ([isOpen]) => {
            if (!isOpen) {
                return;
            }

            void dropdownPopup.updateData();
        },
        { flush: 'post' }
    );

    return {
        openModelDropdownWithLayoutSync,
        closeModelDropdown,
        hideAllDropdowns,
        handleToggleModelDropdownRequest,
    };
}

/**
 * 搜索页键盘与全局输入链路。
 * 负责页面级按键路由、主窗口空白点击收敛和 dropdown/QuickSearch 的键盘协调。
 *
 * @param options 页面状态与交互回调。
 * @returns void
 */
export function useSearchKeyboard(options: UseSearchKeyboardOptions) {
    const {
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
        hideAllDropdowns,
        closeModelDropdown,
        openModelDropdown,
        handleSubmit,
        clearAll,
        cancelRequest,
        clearConversation,
    } = options;

    let lastBackspaceTime = 0;

    function handleSearchWindowMouseDown(event: MouseEvent) {
        if (!viewReady.value) {
            return;
        }

        const target = event.target as HTMLElement | null;
        if (target?.closest('.logo-container')) {
            return;
        }

        if (modelDropdownState.value.isOpen) {
            void hideAllDropdowns();
            event.preventDefault();
            event.stopPropagation();
        }
    }

    function handleSearchWindowClick(event: MouseEvent) {
        if (!viewReady.value) {
            return;
        }

        if (event.target === document.body) {
            void native.window.hideSearchWindow();
        }
    }

    async function handleKeyDown(event: KeyboardEvent) {
        if (!viewReady.value) {
            return;
        }

        if (isDevMode && event.key === 'Control' && !event.repeat) {
            isDevBlurHideSuspended.value = !isDevBlurHideSuspended.value;
            return;
        }

        if (event.key === 'Tab' && conversationHistory.value.length > 0) {
            event.preventDefault();
            controller.focusConversation();
            return;
        }

        // Escape 作为 UI 状态回退键，优先收敛弹窗/请求，再处理输入清理。
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();

            if (modelDropdownState.value.isOpen) {
                await closeModelDropdown();
                return;
            }

            if (isLoading.value) {
                cancelRequest();
                return;
            }

            const hasSelectedModel = modelOverride.value.modelId;
            if (!queryText.value.trim() && hasSelectedModel) {
                modelOverride.value = createEmptyModelOverride();
                return;
            }

            if (!queryText.value.trim() && conversationHistory.value.length === 0) {
                await getCurrentWindow().hide();
                return;
            }

            if (conversationHistory.value.length > 0) {
                clearConversation();
                return;
            }

            clearAll();
            return;
        }

        if (event.key === '@' && !modelDropdownState.value.isOpen) {
            event.preventDefault();
            await openModelDropdown();
            return;
        }

        if (modelDropdownState.value.isOpen) {
            if (['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
                event.preventDefault();
                emit('popup-keydown', { key: event.key });
                return;
            }
        }

        if (isQuickSearchOpen.value) {
            const hasHighlight = controller.isQuickSearchItemHighlighted();

            if (hasHighlight) {
                const directionMap = {
                    ArrowUp: 'up',
                    ArrowDown: 'down',
                    ArrowLeft: 'left',
                    ArrowRight: 'right',
                } as const;
                const direction = directionMap[event.key as keyof typeof directionMap];
                if (direction) {
                    event.preventDefault();
                    controller.moveQuickSearchSelection(direction);
                    return;
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    await controller.openHighlightedQuickSearchItem();
                    return;
                }
            } else {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    controller.moveQuickSearchSelection('down');
                    return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    controller.closeQuickSearch();
                    if (queryText.value.trim()) {
                        await handleSubmit(queryText.value);
                    }
                    return;
                }
            }
        }

        if (!modelDropdownState.value.isOpen && !isQuickSearchOpen.value) {
            if (event.key === 'ArrowDown') {
                if (!shouldTriggerQuickSearch(queryText.value)) {
                    return;
                }

                event.preventDefault();
                controller.openQuickSearch();
                return;
            }

            if (event.key === 'ArrowUp') {
                if (cursorContext.value.isMultiLine) {
                    return;
                }
                event.preventDefault();
                if (queryText.value.trim()) {
                    await handleSubmit(queryText.value);
                }
                return;
            }
        }

        if (event.key === 'Backspace') {
            if (modelDropdownState.value.isOpen) {
                await closeModelDropdown();
                return;
            }

            if (pendingRequest.value) {
                const now = Date.now();
                const timeSinceLastBackspace = now - lastBackspaceTime;
                lastBackspaceTime = now;

                // 双击退格清空待发送请求，避免额外的确认弹窗阻塞输入流。
                if (timeSinceLastBackspace < DOUBLE_BACKSPACE_INTERVAL) {
                    event.preventDefault();
                    pendingRequest.value = null;
                    isWaitingForCompletion.value = false;
                    lastBackspaceTime = 0;
                }
                return;
            }

            if (modelOverride.value.modelId && cursorContext.value.cursorAtStart) {
                event.preventDefault();
                modelOverride.value = createEmptyModelOverride();
                return;
            }
        }

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (queryText.value.trim()) {
                await handleSubmit(queryText.value);
            }
        }
    }

    onMounted(() => {
        window.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('mousedown', handleSearchWindowMouseDown, true);
        document.body.addEventListener('click', handleSearchWindowClick);
    });

    onUnmounted(() => {
        window.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('mousedown', handleSearchWindowMouseDown, true);
        document.body.removeEventListener('click', handleSearchWindowClick);
    });
}
