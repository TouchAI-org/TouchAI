// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { computed, nextTick, onUnmounted, type Ref, ref, watch } from 'vue';

import { type SearchWindowDefaultSize, SearchWindowHeightMode } from '@/config/searchWindow';
import { markPerformanceTrace } from '@/services/PerformanceTraceService';
import {
    createLatestSearchHeightResizeScheduler,
    createWindowViewportSyncScheduler,
    ensureWindowMaximized,
    ensureWindowRestoredFromMaximized,
    resolveEffectiveWindowMaximized,
    resolveSearchHeightTarget,
    resolveSearchWindowDefaultSizeApplyAction,
    resolveSearchWindowHeightPolicy,
    resolveSearchWindowMinimumSize,
    type SearchHeightResizeReason,
    type SearchHeightResizeRequest,
    shouldEnforceIdleDefaultBounds,
    shouldFillConversationAvailableHeight,
    shouldRemeasureAfterMaximizedRestore,
    shouldRepairIdleSearchWindowHeight,
} from '@/views/SearchView/windowSizing';

const SEARCH_WINDOW_GROWTH_OVERSHOOT_PX = 4;

interface UseSearchWindowResizeOptions {
    target: Ref<HTMLElement | null>;
    sessionCount: Ref<number>;
    quickSearchOpen: Ref<boolean>;
    conversationPending: Ref<boolean>;
    defaultSize: Ref<SearchWindowDefaultSize>;
    ready: Ref<boolean>;
}

/**
 * 搜索窗口大小专用状态机。
 *
 * 负责统一管理页面内容高度、原生窗口状态、搜索窗口策略。
 * 原则：原生窗口负责动画，前端只根据真实窗口尺寸暂时锁住可视 viewport。
 */
export function useSearchWindowResize(options: UseSearchWindowResizeOptions) {
    const currentWindow = getCurrentWindow();
    const currentHeight = ref(0);
    const visibleViewportHeightLock = ref<number | null>(null);
    const windowScaleFactor = ref(1);
    const desiredMaximized = ref(false);
    const isMaximizeTransitioning = ref(false);
    const searchWindowHeightMode = ref<SearchWindowHeightMode>(SearchWindowHeightMode.Auto);
    const searchWindowResizeConstraintsReady = ref(false);

    const searchWindowHeightPolicy = computed(() =>
        resolveSearchWindowHeightPolicy({
            sessionCount: options.sessionCount.value,
            quickSearchOpen: options.quickSearchOpen.value,
            conversationPending: options.conversationPending.value,
        })
    );
    const effectiveWindowMaximized = computed(() =>
        resolveEffectiveWindowMaximized(desiredMaximized.value, isMaximizeTransitioning.value)
    );
    const autoHeightEnabled = computed(() => {
        const manualOverrideActive =
            searchWindowHeightPolicy.value.respectManualOverride &&
            searchWindowHeightMode.value === SearchWindowHeightMode.ManualOverride;

        return (
            options.ready.value &&
            searchWindowHeightPolicy.value.autoResizeEnabled &&
            !effectiveWindowMaximized.value &&
            !manualOverrideActive
        );
    });
    const fillConversationAvailableHeight = computed(() =>
        shouldFillConversationAvailableHeight({
            hasConversationPanel: options.sessionCount.value > 0,
            isMaximized: effectiveWindowMaximized.value,
            shouldRespectManualHeightOverride:
                searchWindowHeightPolicy.value.respectManualOverride &&
                searchWindowHeightMode.value === SearchWindowHeightMode.ManualOverride,
        })
    );
    const contentReady = computed(
        () => options.ready.value && searchWindowResizeConstraintsReady.value
    );
    const shouldLockVisibleViewport = computed(
        () => options.sessionCount.value > 0 || options.conversationPending.value
    );
    const conversationBootstrapTransition = computed(
        () => options.conversationPending.value && !options.quickSearchOpen.value
    );
    const streamingConversationResizeTransaction = computed(
        () => options.conversationPending.value && options.sessionCount.value > 0
    );

    let resizeObserver: ResizeObserver | null = null;
    let unlistenWindowResize: (() => void) | null = null;
    let lastResizeConstraintsKey: string | null = null;
    let lastAllowHeightOverride: boolean | null = null;
    let lastSyncedDefaultSizeKey: string | null = null;
    let pendingDefaultSizeApplyAfterRestore = false;
    let lastRequestedHeight: number | null = null;
    let resizeTransactionInFlight = false;
    let resizeCommitEpoch = 0;
    let activeResizeDirection: 'grow' | 'shrink' | null = null;
    let pendingProgrammaticTargetHeight: number | null = null;
    let pendingObserverRemeasure = false;
    let unmounted = false;
    let shrinkObserverReboundGuard: {
        targetHeight: number;
        upperBoundHeight: number;
    } | null = null;

    const viewportSyncScheduler = createWindowViewportSyncScheduler(syncViewportState, 80);
    const heightResizeScheduler = createLatestSearchHeightResizeScheduler({
        commit: commitResize,
        onDropped: (request) => {
            markPerformanceTrace('search.resize.dropped', {
                height: request.targetHeight,
                reason: request.reason,
            });
        },
        onError: (error) => {
            reportError('apply coalesced height resize', error);
        },
    });

    function reportError(action: string, error: unknown) {
        console.error(`[SearchView] Failed to ${action}:`, error);
    }

    function getDefaultSizeKey() {
        const { width, height } = options.defaultSize.value;
        return `${width}:${height}`;
    }

    function measureElementHeight(el: HTMLElement) {
        return Math.max(
            el.getBoundingClientRect().height,
            el.clientHeight,
            el.scrollHeight,
            el.offsetHeight
        );
    }

    function clearViewportHeightLock() {
        visibleViewportHeightLock.value = null;
    }

    function applyViewportHeightLock(height: number | null) {
        if (
            height === null ||
            !shouldLockVisibleViewport.value ||
            effectiveWindowMaximized.value ||
            height <= 0
        ) {
            clearViewportHeightLock();
            return;
        }

        visibleViewportHeightLock.value = height;
    }

    function syncViewportHeightLockFromPhysicalSize(payload: {
        height: number;
        toLogical: (scaleFactor: number) => { width: number; height: number };
    }) {
        if (!resizeTransactionInFlight || !shouldLockVisibleViewport.value) {
            return;
        }

        const logicalSize = payload.toLogical(Math.max(windowScaleFactor.value, 1));
        applyViewportHeightLock(Math.round(logicalSize.height));
    }

    async function isWindowVisible() {
        return currentWindow.isVisible().catch(() => true);
    }

    async function syncWindowScaleFactor() {
        windowScaleFactor.value = await currentWindow.scaleFactor().catch(() => 1);
    }

    async function syncMaximizedState() {
        desiredMaximized.value = await currentWindow.isMaximized().catch(() => false);
    }

    async function syncSearchWindowHeightMode() {
        if (resizeTransactionInFlight) {
            return;
        }

        const state = await native.window.getSearchWindowState();
        searchWindowHeightMode.value = state.heightMode;

        if (state.heightMode === SearchWindowHeightMode.Auto) {
            currentHeight.value = state.currentHeight;
        }
    }

    async function syncWindowState() {
        await syncWindowScaleFactor();
        await syncMaximizedState();
        await syncSearchWindowHeightMode();
    }

    async function syncSearchWindowAllowHeightOverride() {
        if (!options.ready.value) {
            return;
        }

        const allowHeightOverride = searchWindowHeightPolicy.value.allowHeightOverride;
        if (lastAllowHeightOverride === allowHeightOverride) {
            return;
        }

        await native.window.setSearchWindowAllowHeightOverride(allowHeightOverride);
        lastAllowHeightOverride = allowHeightOverride;
    }

    async function syncSearchWindowMinSizeConstraints(nextAutoHeightFloor?: number) {
        if (!options.ready.value) {
            return;
        }

        const defaultSize = options.defaultSize.value;
        const autoHeightFloor = Math.max(
            defaultSize.height,
            nextAutoHeightFloor ?? currentHeight.value ?? 0
        );
        const constraints = resolveSearchWindowMinimumSize({
            defaultWidth: defaultSize.width,
            defaultHeight: defaultSize.height,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
            autoHeightFloor,
        });
        const constraintsKey = JSON.stringify(constraints);

        if (lastResizeConstraintsKey === constraintsKey) {
            searchWindowResizeConstraintsReady.value = true;
            return;
        }

        await native.window.setSearchWindowMinSize(constraints);
        lastResizeConstraintsKey = constraintsKey;
        searchWindowResizeConstraintsReady.value = true;
    }

    async function resetSearchWindowBounds() {
        resizeCommitEpoch += 1;
        clearViewportHeightLock();
        currentHeight.value = options.defaultSize.value.height;
        lastRequestedHeight = null;
        resizeTransactionInFlight = false;
        activeResizeDirection = null;
        pendingProgrammaticTargetHeight = null;
        pendingObserverRemeasure = false;
        shrinkObserverReboundGuard = null;
        searchWindowHeightMode.value = SearchWindowHeightMode.Auto;
        await native.window.resetSearchWindowBounds();
        await syncSearchWindowMinSizeConstraints();
    }

    async function commitResize(request: SearchHeightResizeRequest) {
        const commitEpoch = resizeCommitEpoch;
        const newHeight = request.targetHeight;
        if (!autoHeightEnabled.value || !(await isWindowVisible())) {
            return;
        }

        if (commitEpoch !== resizeCommitEpoch) {
            return;
        }

        const previousHeight = currentHeight.value;
        const isShrink = newHeight < currentHeight.value;
        activeResizeDirection = isShrink ? 'shrink' : 'grow';
        pendingProgrammaticTargetHeight = newHeight;
        pendingObserverRemeasure = false;

        markPerformanceTrace('search.resize.sent', {
            height: newHeight,
            reason: request.reason,
        });

        resizeTransactionInFlight = true;

        try {
            if (newHeight < currentHeight.value) {
                await syncSearchWindowMinSizeConstraints(newHeight);
                if (commitEpoch !== resizeCommitEpoch) {
                    return;
                }
            }

            await native.window.resizeWindowHeight({
                targetHeight: newHeight,
                center: true,
                animate: true,
                respectManualOverride: searchWindowHeightPolicy.value.respectManualOverride,
            });
            if (commitEpoch !== resizeCommitEpoch) {
                return;
            }

            currentHeight.value = newHeight;
            lastRequestedHeight = newHeight;
            shrinkObserverReboundGuard = isShrink
                ? {
                      targetHeight: newHeight,
                      upperBoundHeight: previousHeight,
                  }
                : null;
            await syncSearchWindowMinSizeConstraints(newHeight);
            if (commitEpoch !== resizeCommitEpoch) {
                return;
            }
        } finally {
            if (commitEpoch === resizeCommitEpoch) {
                resizeTransactionInFlight = false;
                activeResizeDirection = null;
                pendingProgrammaticTargetHeight = null;
                clearViewportHeightLock();
            }
        }

        markPerformanceTrace('search.resize.committed', {
            height: newHeight,
            reason: request.reason,
        });

        if (pendingObserverRemeasure) {
            pendingObserverRemeasure = false;
            await remeasureTargetHeight();
        }
    }

    function scheduleResize(pageHeight: number, reason: SearchHeightResizeReason) {
        const newHeight = resolveSearchHeightTarget({
            measuredHeight: pageHeight,
            currentHeight: currentHeight.value,
            growthOvershootPx: SEARCH_WINDOW_GROWTH_OVERSHOOT_PX,
        });

        if (reason === 'observer') {
            if (resizeTransactionInFlight) {
                const shouldRemeasureAfterTransaction =
                    pendingProgrammaticTargetHeight !== null &&
                    newHeight > pendingProgrammaticTargetHeight;
                pendingObserverRemeasure =
                    pendingObserverRemeasure || shouldRemeasureAfterTransaction;
                return;
            }

            if (
                shrinkObserverReboundGuard &&
                newHeight > shrinkObserverReboundGuard.targetHeight &&
                newHeight < shrinkObserverReboundGuard.upperBoundHeight
            ) {
                return;
            }

            if (
                pendingProgrammaticTargetHeight !== null &&
                activeResizeDirection === 'shrink' &&
                newHeight > pendingProgrammaticTargetHeight
            ) {
                return;
            }

            if (
                (conversationBootstrapTransition.value ||
                    streamingConversationResizeTransaction.value) &&
                newHeight < currentHeight.value
            ) {
                return;
            }
        }

        if (
            shrinkObserverReboundGuard &&
            (newHeight <= shrinkObserverReboundGuard.targetHeight ||
                newHeight >= shrinkObserverReboundGuard.upperBoundHeight)
        ) {
            shrinkObserverReboundGuard = null;
        }

        if (newHeight === lastRequestedHeight) {
            return;
        }

        markPerformanceTrace('search.resize.requested', {
            height: newHeight,
            reason,
        });

        heightResizeScheduler.schedule({
            targetHeight: newHeight,
            reason,
        });
    }

    function resizeToTargetElement(el: HTMLElement, reason: SearchHeightResizeReason) {
        scheduleResize(measureElementHeight(el), reason);
    }

    async function remeasureTargetHeight() {
        const target = options.target.value;
        if (!target) {
            return;
        }

        shrinkObserverReboundGuard = null;
        await nextTick();
        resizeToTargetElement(target, 'manual-remeasure');
    }

    async function syncSearchWindowDefaults() {
        if (!options.ready.value) {
            return;
        }

        const defaultSizeKey = getDefaultSizeKey();
        if (lastSyncedDefaultSizeKey !== defaultSizeKey) {
            await native.window.setSearchWindowDefaults(options.defaultSize.value);
            lastSyncedDefaultSizeKey = defaultSizeKey;
        }

        const applyAction = resolveSearchWindowDefaultSizeApplyAction({
            ready: options.ready.value,
            maximized: effectiveWindowMaximized.value,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
        });

        if (applyAction === 'skip') {
            pendingDefaultSizeApplyAfterRestore = effectiveWindowMaximized.value;
            await syncSearchWindowMinSizeConstraints();
            return;
        }

        pendingDefaultSizeApplyAfterRestore = false;
        await resetSearchWindowBounds();

        if (applyAction === 'reset_and_remeasure_managed_panel') {
            await remeasureTargetHeight();
        }
    }

    async function syncViewportState(previousMaximized = desiredMaximized.value) {
        if (!options.ready.value) {
            return;
        }

        await syncWindowState();
        await syncSearchWindowAllowHeightOverride();
        await syncSearchWindowMinSizeConstraints();

        if (pendingDefaultSizeApplyAfterRestore && !effectiveWindowMaximized.value) {
            await syncSearchWindowDefaults();
            return;
        }

        if (
            shouldRemeasureAfterMaximizedRestore({
                wasMaximized: previousMaximized,
                isMaximized: desiredMaximized.value,
                hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
            })
        ) {
            await remeasureTargetHeight();
        }
    }

    async function toggleMaximize() {
        if (isMaximizeTransitioning.value) {
            return;
        }

        const wasMaximized = desiredMaximized.value;
        const nextMaximized = !wasMaximized;

        desiredMaximized.value = nextMaximized;
        isMaximizeTransitioning.value = true;

        try {
            if (nextMaximized) {
                await ensureWindowMaximized(currentWindow);
            } else {
                await ensureWindowRestoredFromMaximized(currentWindow);
            }
        } finally {
            await syncViewportState(wasMaximized).catch((error) => {
                reportError('sync viewport state after maximize toggle', error);
            });
            isMaximizeTransitioning.value = false;
        }
    }

    function observeTarget(el: HTMLElement) {
        resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const target = entry.target as HTMLElement;
                const height = Math.max(
                    entry.borderBoxSize?.[0]?.blockSize ?? target.clientHeight,
                    target.scrollHeight,
                    target.getBoundingClientRect().height
                );
                markPerformanceTrace('search.resize.observed', {
                    height,
                    reason: 'observer',
                });
                scheduleResize(height, 'observer');
            }
        });
        resizeObserver.observe(el);

        const runInitialResize = () => {
            if (autoHeightEnabled.value) {
                void remeasureTargetHeight().catch((error) => {
                    reportError('run initial managed-panel resize', error);
                });
            }
        };

        if (document.readyState === 'complete') {
            runInitialResize();
        } else {
            window.addEventListener('load', runInitialResize, { once: true });
        }
    }

    function cleanup() {
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
    }

    watch(
        options.target,
        (el) => {
            cleanup();
            if (el) {
                observeTarget(el);
            }
        },
        { immediate: true }
    );

    watch(
        () => options.ready.value,
        (ready) => {
            if (!ready) {
                searchWindowResizeConstraintsReady.value = false;
                return;
            }

            void syncWindowState().catch((error) => {
                reportError('sync window state', error);
            });
            void syncSearchWindowAllowHeightOverride().catch((error) => {
                reportError('sync height override policy', error);
            });
            void syncSearchWindowDefaults().catch((error) => {
                reportError('sync search window defaults', error);
            });
        },
        { immediate: true, flush: 'post' }
    );

    watch(
        () => ({
            ready: options.ready.value,
            defaultWidth: options.defaultSize.value.width,
            defaultHeight: options.defaultSize.value.height,
        }),
        ({ ready, defaultWidth, defaultHeight }, previous) => {
            if (!ready) {
                return;
            }

            if (
                previous &&
                previous.defaultWidth === defaultWidth &&
                previous.defaultHeight === defaultHeight
            ) {
                return;
            }

            void syncSearchWindowDefaults().catch((error) => {
                reportError('apply search window defaults', error);
            });
        },
        { flush: 'post' }
    );

    watch(
        () => ({
            ready: options.ready.value,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
            allowHeightOverride: searchWindowHeightPolicy.value.allowHeightOverride,
        }),
        ({ ready }) => {
            if (!ready) {
                return;
            }

            void syncSearchWindowAllowHeightOverride().catch((error) => {
                reportError('sync search window override policy', error);
            });
            void syncSearchWindowMinSizeConstraints().catch((error) => {
                reportError('sync search window min size', error);
            });
        },
        { immediate: true, flush: 'post' }
    );

    watch(
        autoHeightEnabled,
        (enabled, previous) => {
            if (!enabled || enabled === previous) {
                return;
            }

            void remeasureTargetHeight().catch((error) => {
                reportError('remeasure managed panel after auto-height re-enabled', error);
            });
        },
        { flush: 'post' }
    );

    watch(
        () => options.conversationPending.value,
        (pending, previous) => {
            if (pending || !previous || !options.ready.value || options.sessionCount.value === 0) {
                return;
            }

            void remeasureTargetHeight().catch((error) => {
                reportError('settle conversation height after streaming completed', error);
            });
        },
        { flush: 'post' }
    );

    watch(
        () => ({
            ready: options.ready.value,
            idle: !searchWindowHeightPolicy.value.hasManagedPanel,
            heightMode: searchWindowHeightMode.value,
            maximized: effectiveWindowMaximized.value,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
        }),
        (current, previous) => {
            if (!current.ready) {
                return;
            }

            const shouldRepairIdleHeight = shouldRepairIdleSearchWindowHeight(
                {
                    ready: current.ready,
                    idle: current.idle,
                    heightMode: current.heightMode,
                    maximized: current.maximized,
                },
                previous
                    ? {
                          ready: previous.ready,
                          idle: previous.idle,
                          heightMode: previous.heightMode,
                          maximized: previous.maximized,
                      }
                    : undefined
            );

            const shouldRepairIdleBounds = shouldEnforceIdleDefaultBounds(
                {
                    ready: current.ready,
                    hasManagedPanel: current.hasManagedPanel,
                    maximized: current.maximized,
                },
                previous
                    ? {
                          ready: previous.ready,
                          hasManagedPanel: previous.hasManagedPanel,
                          maximized: previous.maximized,
                      }
                    : undefined
            );

            if (!shouldRepairIdleHeight && !shouldRepairIdleBounds) {
                return;
            }

            void resetSearchWindowBounds().catch((error) => {
                reportError('repair idle search window bounds', error);
            });
        },
        { flush: 'post' }
    );

    currentWindow
        .onResized(({ payload }) => {
            if (!options.ready.value) {
                return;
            }

            syncViewportHeightLockFromPhysicalSize(payload);
            viewportSyncScheduler.schedule();
        })
        .then((unlisten) => {
            if (unmounted) {
                unlisten();
                return;
            }

            unlistenWindowResize = unlisten;
        })
        .catch((error) => {
            reportError('listen for window resize', error);
        });

    onUnmounted(() => {
        unmounted = true;
        cleanup();
        clearViewportHeightLock();
        heightResizeScheduler.cancel();
        viewportSyncScheduler.cancel();
        unlistenWindowResize?.();
    });

    return {
        contentReady,
        isMaximized: desiredMaximized,
        effectiveWindowMaximized,
        fillConversationAvailableHeight,
        visibleViewportHeightLock,
        toggleMaximize,
        syncWindowState,
        remeasureTargetHeight,
    };
}
