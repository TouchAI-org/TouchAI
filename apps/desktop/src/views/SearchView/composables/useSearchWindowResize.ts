// Copyright (c) 2026. 閸楀啳鐦? Licensed under GPL v3.

import { useMotion } from '@composables/useMotion';
import { native } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { computed, nextTick, onUnmounted, type Ref, ref, shallowRef, watch } from 'vue';

import {
    SEARCH_SURFACE_EASING,
    SEARCH_SURFACE_MOTION,
    type SearchWindowDefaultSize,
    SearchWindowHeightMode,
} from '@/config/searchWindow';
import {
    resolveContentPanelHeight,
    resolveSurfacePanelStyle,
    resolveVisibleSearchViewport,
    SEARCH_PANEL_MIN_HEIGHT,
    shouldCommitPanelHeight,
} from '@/views/SearchView/searchSurfaceLayout';
import { SEARCH_WINDOW_VISUAL_OUTSET } from '@/views/SearchView/searchWindowRegions';
import {
    createWindowViewportSyncScheduler,
    ensureWindowMaximized,
    ensureWindowRestoredFromMaximized,
    resolveAutoSessionPanelHeight,
    resolveEffectiveWindowMaximized,
    resolveSearchWindowDefaultSizeApplyAction,
    resolveSearchWindowHeightPolicy,
    resolveSearchWindowMeasuredHeight,
    resolveSearchWindowMinimumSize,
    SEARCH_WINDOW_TOP_INSET,
    shouldFillConversationAvailableHeight,
    shouldRemeasureAfterMaximizedRestore,
} from '@/views/SearchView/windowSizing';

interface UseSearchWindowResizeOptions {
    askUserOpen?: Ref<boolean>;
    target: Ref<HTMLElement | null>;
    inputArea?: Ref<HTMLElement | null>;
    picker?: Ref<HTMLElement | null>;
    floatingPicker?: Readonly<Ref<boolean>>;
    /** Read natural content independently of the viewport that clips it. */
    measureContentHeight?: (target: HTMLElement) => number;
    overlayTarget?: Ref<HTMLElement | null>;
    card?: Ref<HTMLElement | null>;
    overlayRequiredViewportHeight?: Ref<number | null>;
    intrinsicHeightMeasurementPending?: Readonly<Ref<boolean>>;
    sessionCount: Ref<number>;
    quickSearchOpen: Ref<boolean>;
    skillAutocompleteOpen?: Readonly<Ref<boolean>>;
    defaultSize: Ref<SearchWindowDefaultSize>;
    ready: Ref<boolean>;
    onLogicalPanelHeightChange?: (height: number) => void;
    preparePanelTransition?: () => Promise<void>;
    onLogicalPanelGeometryChange?: () => void;
    onHostViewportChange?: () => void;
    resizeEnabled?: Readonly<Ref<boolean>>;
}

export interface LogicalSearchPanelSize {
    width: number;
    height: number;
}

interface HeightChange {
    fromHeight: number;
    toHeight: number;
    fromTop: number;
}

/** Coalesce observer bursts without delaying the native clipping boundary. */
const MEASURE_COALESCE_MS = 16;

/** One serialized geometry owner coordinates native bounds and the visible card. */
export function useSearchWindowResize(options: UseSearchWindowResizeOptions) {
    const currentWindow = getCurrentWindow();
    const { reducedMotion, duration: motionDuration } = useMotion();

    const currentWidth = ref(0);
    const currentHeight = ref(0);
    const inputAreaHeight = ref(options.defaultSize.value.height);
    const pickerHeight = ref(0);
    const activeHeightChange = shallowRef<HeightChange | null>(null);
    const cardAnimation = shallowRef<Animation | null>(null);
    // Hold the previous layout until native bounds can contain the next frame.
    const cardHeight = computed(() => activeHeightChange.value?.fromHeight ?? currentHeight.value);
    const monitorHost = ref(false);
    const desiredMaximized = ref(false);
    const isMaximizeTransitioning = ref(false);
    const isLogicalPanelResizing = ref(false);
    const nativeDragLayout = shallowRef<ReturnType<typeof resolveSurfacePanelStyle> | null>(null);
    const displayScaleFactor = ref(window.devicePixelRatio);
    const workAreaHeight = ref<number | null>(null);
    const workAreaWidth = ref<number | null>(null);
    const workAreaLeft = ref(0);
    const workAreaTop = ref(0);
    const viewportHeight = ref(window.innerHeight);
    const viewportWidth = ref(window.innerWidth);
    const panelCenterY = ref<number | null>(null);
    const hostOrigin = ref({ x: 0, y: 0 });
    const visibleViewport = computed(() =>
        resolveVisibleSearchViewport({
            viewportWidth: viewportWidth.value,
            viewportHeight: viewportHeight.value,
            hostX: hostOrigin.value.x,
            hostY: hostOrigin.value.y,
            workAreaLeft: workAreaWidth.value === null ? hostOrigin.value.x : workAreaLeft.value,
            workAreaTop: workAreaHeight.value === null ? hostOrigin.value.y : workAreaTop.value,
            workAreaWidth: workAreaWidth.value ?? viewportWidth.value * scaleFactor(),
            workAreaHeight: workAreaHeight.value ?? viewportHeight.value * scaleFactor(),
            scaleFactor: scaleFactor(),
        })
    );
    const minimumPanelHeight = computed(() =>
        Math.max(SEARCH_PANEL_MIN_HEIGHT, options.defaultSize.value.height)
    );
    const panelViewportHeight = computed(() =>
        workAreaHeight.value === null
            ? viewportHeight.value
            : Math.min(viewportHeight.value, workAreaHeight.value / scaleFactor())
    );
    const panelBounds = computed(() => {
        const topInset = SEARCH_WINDOW_TOP_INSET / scaleFactor();
        // Card capacity belongs to the host; moving it off-screen only limits overlays.
        const insetScale = Math.min(
            1,
            Math.max(
                0,
                (panelViewportHeight.value - minimumPanelHeight.value) /
                    (topInset + SEARCH_WINDOW_VISUAL_OUTSET)
            )
        );
        return {
            top: topInset * insetScale,
            bottom: panelViewportHeight.value - SEARCH_WINDOW_VISUAL_OUTSET * insetScale,
        };
    });
    const availablePanelHeight = computed(() =>
        workAreaHeight.value === null
            ? Number.POSITIVE_INFINITY
            : Math.max(
                  minimumPanelHeight.value,
                  Math.floor(
                      monitorHost.value
                          ? panelBounds.value.bottom - panelBounds.value.top
                          : workAreaHeight.value / scaleFactor()
                  )
              )
    );
    const searchWindowHeightMode = ref<SearchWindowHeightMode>(SearchWindowHeightMode.Auto);
    const searchWindowResizeConstraintsReady = ref(false);
    const isSurfaceAnimating = computed(
        () => activeHeightChange.value !== null || cardAnimation.value !== null
    );
    /** WAAPI supplies an explicit start frame even when Vue applies layout and animation together. */
    function animateCardHeight(
        fromHeight: number,
        toHeight: number,
        duration: number,
        startOffset: number,
        endOffset: number
    ): Animation | null {
        const card = options.card?.value ?? null;
        if (!card || typeof card.animate !== 'function') return null;
        if (reducedMotion.value || duration <= 0 || Math.abs(fromHeight - toHeight) < 1)
            return null;

        return card.animate(
            [
                {
                    height: `${fromHeight}px`,
                    transform: `translateY(${startOffset}px)`,
                },
                {
                    height: `${toHeight}px`,
                    transform: `translateY(${endOffset}px)`,
                },
            ],
            {
                duration,
                easing: SEARCH_SURFACE_EASING,
                fill: 'both',
            }
        );
    }
    /**
     * Held while a QuickSearch list is folding into a conversation.
     *
     * The list still occupies part of the layout while it folds, so measuring then would add
     * the fading results to the conversation and commit a transient sum. The fold ends with one
     * measurement of the conversation alone.
     */
    const measurementHold = ref(false);

    function cancelCardAnimation(animation = cardAnimation.value) {
        if (animation === cardAnimation.value) cardAnimation.value = null;
        animation?.cancel();
    }

    function claimGeometry() {
        const generation = ++commitGeneration;
        isMaximizeTransitioning.value = false;
        cancelCardAnimation();
        activeHeightChange.value = null;
        return generation;
    }

    function isCurrentGeometry(generation: number) {
        return !windowListenersDisposed && generation === commitGeneration;
    }

    function enqueueGeometry<T>(generation: number, operation: () => Promise<T>) {
        const run = commitQueue.then(async () => {
            if (isCurrentGeometry(generation)) return operation();
        });
        commitQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    function finishCardTransition(
        change: HeightChange,
        generation: number,
        animation: Animation | null,
        settled = true
    ) {
        cancelCardAnimation(animation);
        if (activeHeightChange.value === change) activeHeightChange.value = null;
        if (!isCurrentGeometry(generation)) return;
        options.onLogicalPanelHeightChange?.(currentHeight.value);
        const target = options.target.value;
        if (target && settled) scheduleMeasurement(target);
    }

    /** Height the card is showing right now, in CSS pixels. */
    function currentCardHeight(): number {
        const card = options.card?.value;
        const height = card?.getBoundingClientRect().height ?? 0;
        return height > 0 ? height : currentHeight.value;
    }

    const isCardGrowing = computed(() => cardAnimation.value !== null);
    watch(reducedMotion, (reduced) => {
        if (reduced) cardAnimation.value?.finish();
    });

    const searchWindowHeightPolicy = computed(() =>
        resolveSearchWindowHeightPolicy({
            askUserOpen: options.askUserOpen?.value ?? false,
            sessionCount: options.sessionCount.value,
            quickSearchOpen: options.quickSearchOpen.value,
            skillAutocompleteOpen: options.skillAutocompleteOpen?.value ?? false,
        })
    );
    const effectiveWindowMaximized = computed(() =>
        resolveEffectiveWindowMaximized(desiredMaximized.value, isMaximizeTransitioning.value)
    );
    const settledWindowMaximized = computed(
        () => desiredMaximized.value && !isMaximizeTransitioning.value
    );
    const autoHeightEnabled = computed(() => {
        const manualOverrideActive =
            searchWindowHeightPolicy.value.respectManualOverride &&
            searchWindowHeightMode.value === SearchWindowHeightMode.ManualOverride;

        return (
            options.ready.value &&
            (options.resizeEnabled?.value ?? true) &&
            searchWindowHeightPolicy.value.autoResizeEnabled &&
            !effectiveWindowMaximized.value &&
            !isLogicalPanelResizing.value &&
            nativeDragLayout.value === null &&
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
            isIntrinsicHeightMeasurementPending:
                options.intrinsicHeightMeasurementPending?.value ?? false,
        })
    );
    const contentReady = computed(
        () => options.ready.value && searchWindowResizeConstraintsReady.value
    );
    const filePickerMaxHeight = computed(() => {
        if (options.floatingPicker?.value) {
            const capacity = effectiveWindowMaximized.value
                ? panelViewportHeight.value
                : Math.min(
                      availablePanelHeight.value,
                      currentHeight.value || options.defaultSize.value.height
                  );
            // Reserve conversation space above the editor even when the card is short
            // or the draft spans multiple lines. The picker never resizes the card.
            return Math.max(0, capacity - inputAreaHeight.value - 1) * 0.8;
        }
        const contentCapacity = effectiveWindowMaximized.value
            ? panelViewportHeight.value
            : Math.min(
                  availablePanelHeight.value,
                  fillConversationAvailableHeight.value
                      ? currentHeight.value || options.defaultSize.value.height
                      : resolveAutoSessionPanelHeight({
                            searchBarHeight: options.defaultSize.value.height,
                        })
              );
        const editorHeight = Math.max(0, inputAreaHeight.value - pickerHeight.value);
        // Leave half of the space below the editor for the conversation rail.
        const available = Math.max(0, contentCapacity - editorHeight - 1);
        return available / (options.sessionCount.value > 0 ? 2 : 1);
    });
    const skillPickerMaxHeight = filePickerMaxHeight;

    const cardStyle = computed(() => ({
        transform:
            monitorHost.value && activeHeightChange.value && panelStyle.value
                ? `translateY(${activeHeightChange.value.fromTop - Number.parseFloat(panelStyle.value.top)}px)`
                : 'none',
    }));
    const settledPanelStyle = computed(
        () =>
            nativeDragLayout.value ??
            resolveSurfacePanelStyle({
                scaleFactor: displayScaleFactor.value,
                maximized: effectiveWindowMaximized.value,
                panelHeight: currentHeight.value,
                viewportHeight: viewportHeight.value,
                centerY: panelCenterY.value,
                minTop: panelBounds.value.top,
                maxBottom: panelBounds.value.bottom,
            })
    );
    // Reserve the union before animating; tightening the native region never clips an in-flight frame.
    const panelStyle = computed(() => {
        if (!monitorHost.value) {
            const style = resolveSurfacePanelStyle({
                scaleFactor: displayScaleFactor.value,
                maximized: true,
            });
            if (effectiveWindowMaximized.value) return style;
            // Hidden WebKit can have a 0×0 viewport. Lay out the accepted panel
            // independently so its first region can be measured before native show.
            return {
                ...style,
                width: `${currentWidth.value || options.defaultSize.value.width}px`,
                height: `${Math.max(currentHeight.value || options.defaultSize.value.height, activeHeightChange.value?.fromHeight ?? 0)}px`,
            };
        }
        const style = { position: 'fixed' as const, ...settledPanelStyle.value };
        const change = activeHeightChange.value;
        if (!change || effectiveWindowMaximized.value) return style;
        const settledTop = Number.parseFloat(style.top);
        const top = Math.min(settledTop, change.fromTop);
        return {
            ...style,
            top: `${top}px`,
            height: `${Math.max(settledTop + currentHeight.value, change.fromTop + change.fromHeight) - top}px`,
        };
    });

    // ---------------------------------------------------------------------
    // Native geometry
    // ---------------------------------------------------------------------
    let windowListenersDisposed = false;
    let lastResizeConstraintsKey: string | null = null;
    let lastAllowHeightOverride: boolean | null = null;
    let lastSyncedDefaultSizeKey: string | null = null;
    let pendingDefaultSizeApplyAfterRestore = false;
    let commitQueue: Promise<void> = Promise.resolve();
    let commitGeneration = 0;
    let resizeObserver: ResizeObserver | null = null;
    let inputResizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let unlistenWindowResize: (() => void) | null = null;
    let unlistenWindowMoved: (() => void) | null = null;
    let unlistenWindowScaleChanged: (() => void) | null = null;
    let measureTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingMeasureTarget: HTMLElement | null = null;
    let failedMeasurement: number | null = null;
    let logicalPanelResizeStart: {
        size: LogicalSearchPanelSize;
        centerY: number | null;
        heightMode: SearchWindowHeightMode;
        generation: number;
    } | null = null;

    const viewportSyncScheduler = createWindowViewportSyncScheduler(syncViewportState, 80);

    function reportError(action: string, error: unknown) {
        log.error(`[SearchView] Failed to ${action}:`, error);
    }

    function notifyHostViewportChange() {
        viewportWidth.value = window.innerWidth;
        viewportHeight.value = window.innerHeight;
        void nextTick().then(() => options.onHostViewportChange?.());
    }

    function getDefaultSizeKey() {
        const { width, height } = options.defaultSize.value;
        return `${width}:${height}`;
    }

    function scaleFactor() {
        return Number.isFinite(displayScaleFactor.value) && displayScaleFactor.value > 0
            ? displayScaleFactor.value
            : 1;
    }

    function commitLogicalPanelHeight(height: number) {
        if (height === currentHeight.value) {
            return false;
        }

        currentHeight.value = height;
        options.onLogicalPanelHeightChange?.(height);
        return true;
    }

    function applyState(state: Awaited<ReturnType<typeof native.window.commitSearchPanelResize>>) {
        currentWidth.value = state.currentWidth;
        searchWindowHeightMode.value = state.heightMode;
        monitorHost.value = state.monitorHost;
        commitLogicalPanelHeight(state.currentHeight);
    }

    function resolveEffectivePanelHeight(
        height: number,
        {
            reset = false,
            respectManualOverride = searchWindowHeightPolicy.value.respectManualOverride,
        } = {}
    ) {
        const current = currentHeight.value || options.defaultSize.value.height;
        const keepManualHeight =
            !reset &&
            respectManualOverride &&
            searchWindowHeightMode.value === SearchWindowHeightMode.ManualOverride;
        const keepOverlayHeight =
            !reset && Boolean(options.overlayTarget?.value) && height < current;
        return Math.min(
            availablePanelHeight.value,
            Math.max(1, Math.round(keepManualHeight || keepOverlayHeight ? current : height))
        );
    }

    /** Serialize native commits and ignore superseded completions. */
    async function commitPanelHeight(
        panelHeight: number,
        commitOptions: {
            placement?: 'idle' | 'work-area' | 'restore';
            reset?: boolean;
            /** An explicit user action clears a stale native manual override. */
            respectManualOverride?: boolean;
        } = {}
    ): Promise<boolean> {
        if (windowListenersDisposed || !options.ready.value) {
            return false;
        }
        if (options.resizeEnabled?.value === false && !commitOptions.reset) return false;
        if (effectiveWindowMaximized.value && !commitOptions.reset) return false;
        if (isLogicalPanelResizing.value && !commitOptions.reset) return false;
        if (nativeDragLayout.value) return false;

        const from = {
            width: currentWidth.value || options.defaultSize.value.width,
            height: currentHeight.value || options.defaultSize.value.height,
        };
        const respectManualOverride =
            commitOptions.respectManualOverride ??
            searchWindowHeightPolicy.value.respectManualOverride;
        const target = resolveEffectivePanelHeight(panelHeight, commitOptions);
        const heightChanged = shouldCommitPanelHeight({
            current: activeHeightChange.value?.toHeight ?? from.height,
            next: target,
        });
        if (!commitOptions.placement && !heightChanged) return true;

        const revealFrom = Math.max(
            1,
            cardAnimation.value
                ? currentCardHeight()
                : (activeHeightChange.value?.fromHeight ?? currentCardHeight())
        );
        const revealTop =
            options.card?.value?.getBoundingClientRect().top ??
            Number.parseFloat(settledPanelStyle.value.top);
        const generation = claimGeometry();
        const wasMaximized = desiredMaximized.value;
        if (commitOptions.reset) desiredMaximized.value = false;
        const change = { fromHeight: revealFrom, toHeight: target, fromTop: revealTop };
        activeHeightChange.value = change;
        const placement = commitOptions.placement ?? 'preserve-origin';
        const animatesCard = Math.abs(revealFrom - target) > 1;

        return (
            (await enqueueGeometry(generation, async () => {
                let animation: Animation | null = null;
                let revealContinues = false;
                let nativeCommitted = false;
                try {
                    if (monitorHost.value) {
                        const state = commitOptions.reset
                            ? await native.window
                                  .resetSearchWindowBounds()
                                  .then(() => native.window.getSearchWindowState())
                            : await native.window.commitSearchPanelResize({
                                  from,
                                  to: { width: from.width, height: target },
                                  auto: !(
                                      respectManualOverride &&
                                      from.height > availablePanelHeight.value &&
                                      searchWindowHeightMode.value ===
                                          SearchWindowHeightMode.ManualOverride
                                  ),
                                  respectManualOverride,
                                  placement,
                              });
                        if (!isCurrentGeometry(generation)) return false;
                        applyState(state);
                        nativeCommitted = true;
                        failedMeasurement = null;
                        if (commitOptions.reset) panelCenterY.value = null;
                        await syncSearchWindowMinSizeConstraints();
                        if (!isCurrentGeometry(generation)) return false;
                        // Keep the old card visible until the OS can paint the full transition envelope.
                        await nextTick();
                        await options.preparePanelTransition?.();
                        if (!isCurrentGeometry(generation)) return false;
                        if (animatesCard) {
                            animation = animateCardHeight(
                                revealFrom,
                                state.currentHeight,
                                motionDuration(SEARCH_SURFACE_MOTION.durationMs),
                                revealTop - Number.parseFloat(panelStyle.value!.top),
                                Number.parseFloat(settledPanelStyle.value.top) -
                                    Number.parseFloat(panelStyle.value!.top)
                            );
                            cardAnimation.value = animation;
                        }
                    } else {
                        if (commitOptions.reset) {
                            await native.window.resetSearchWindowBounds();
                        } else {
                            await native.window.resizeWindowHeight({
                                targetHeight: target,
                                center: true,
                                animate: false,
                                respectManualOverride,
                            });
                        }
                        if (!isCurrentGeometry(generation)) return false;
                        const state = await native.window.getSearchWindowState();
                        if (!isCurrentGeometry(generation)) return false;
                        applyState(state);
                        nativeCommitted = true;
                        failedMeasurement = null;
                        await syncSearchWindowMinSizeConstraints();
                    }
                    if (change) {
                        await nextTick();
                        if (!isCurrentGeometry(generation)) return false;
                        if (animation) {
                            const reveal = animation;
                            revealContinues = true;
                            void reveal.finished
                                .catch(() => undefined)
                                .then(() => finishCardTransition(change, generation, reveal));
                        }
                    }
                    return true;
                } catch (error) {
                    reportError('commit search panel height', error);
                    if (!nativeCommitted && isCurrentGeometry(generation)) {
                        failedMeasurement = target;
                        if (commitOptions.reset) desiredMaximized.value = wasMaximized;
                    }
                    return false;
                } finally {
                    if (change && !revealContinues) {
                        finishCardTransition(change, generation, animation, nativeCommitted);
                    }
                }
            })) ?? false
        );
    }

    // ---------------------------------------------------------------------
    // Measurement
    // ---------------------------------------------------------------------
    function measureContentHeight(el: HTMLElement) {
        return Math.max(
            el.getBoundingClientRect().height,
            el.clientHeight,
            el.scrollHeight,
            el.offsetHeight
        );
    }

    function resolveMeasuredPanelHeight(el: HTMLElement) {
        // Alignment slack and the animated viewport are outputs, never content measurements.
        const card = options.card?.value;
        const style = card ? getComputedStyle(card) : null;
        const borderHeight =
            (Number.parseFloat(style?.borderTopWidth ?? '') || 0) +
            (Number.parseFloat(style?.borderBottomWidth ?? '') || 0);
        const contentHeight =
            (options.measureContentHeight?.(el) ?? measureContentHeight(el)) + borderHeight;

        const panelHeight = resolveContentPanelHeight({
            contentHeight,
            compactHeight: options.defaultSize.value.height,
            maxHeight: resolveAutoSessionPanelHeight({
                searchBarHeight: options.defaultSize.value.height,
            }),
        });

        // The Windows host already contains overlays. Other platforms still size the native window.
        return Math.min(
            availablePanelHeight.value,
            resolveSearchWindowMeasuredHeight({
                panelHeight,
                overlayBottom: options.overlayTarget?.value?.getBoundingClientRect().bottom ?? null,
                overlayRequiredViewportHeight: options.overlayRequiredViewportHeight?.value ?? null,
                monitorHost: monitorHost.value,
            })
        );
    }

    function scheduleMeasurement(el = options.target.value) {
        if (!el) return;
        pendingMeasureTarget = el;
        if (isLogicalPanelResizing.value || isSurfaceAnimating.value || measurementHold.value)
            return;
        if (measureTimer !== null) return;

        measureTimer = setTimeout(() => {
            measureTimer = null;
            const target = pendingMeasureTarget;
            pendingMeasureTarget = null;
            // The hold can start after this timer was queued -- a submit freezes the height loop
            // while the surface is still empty -- so the check has to happen when it fires, not only
            // when the measurement is scheduled.
            if (measurementHold.value || isSurfaceAnimating.value) return;
            if (!target || windowListenersDisposed || !autoHeightEnabled.value) {
                return;
            }

            const nextHeight = resolveEffectivePanelHeight(resolveMeasuredPanelHeight(target));
            // Rolling back an animation fires ResizeObserver too. Only a changed target
            // or an explicit remeasurement should retry a failed native operation.
            if (failedMeasurement === nextHeight) return;
            void commitPanelHeight(nextHeight).catch((error) => {
                reportError('apply measured content height', error);
            });
        }, MEASURE_COALESCE_MS);
    }

    function observeTargetHeight(el: HTMLElement) {
        resizeObserver?.disconnect();
        resizeObserver = new ResizeObserver(() => scheduleMeasurement(el));
        resizeObserver.observe(el);
        // In a filled conversation, controls can grow while the outer viewport stays fixed.
        for (const child of el.children) resizeObserver.observe(child);
        if (options.overlayTarget?.value) {
            resizeObserver.observe(options.overlayTarget.value);
        }
    }

    function observeTarget(el: HTMLElement) {
        observeTargetHeight(el);

        mutationObserver?.disconnect();
        mutationObserver = new MutationObserver(() => {
            observeTargetHeight(el);
            scheduleMeasurement(el);
        });
        mutationObserver.observe(el, { childList: true });

        const initialMeasurement = () => {
            if (!autoHeightEnabled.value) return;
            void remeasureTargetHeight().catch((error) => {
                reportError('run initial surface measurement', error);
            });
        };

        if (document.readyState === 'complete') {
            initialMeasurement();
        } else {
            window.addEventListener('load', initialMeasurement, { once: true });
        }
    }

    function disposeObservers() {
        if (measureTimer !== null) {
            clearTimeout(measureTimer);
            measureTimer = null;
        }
        pendingMeasureTarget = null;
        resizeObserver?.disconnect();
        resizeObserver = null;
        mutationObserver?.disconnect();
        mutationObserver = null;
    }

    // ---------------------------------------------------------------------
    // Native window state
    // ---------------------------------------------------------------------
    async function syncSearchWindowHeightMode() {
        const generation = commitGeneration;
        await enqueueGeometry(generation, async () => {
            const state = await native.window.getSearchWindowState();
            if (!isCurrentGeometry(generation) || isLogicalPanelResizing.value) return;
            applyState(state);
        });
    }

    async function syncMaximizedState() {
        if (!monitorHost.value) {
            desiredMaximized.value = await currentWindow.isMaximized().catch(() => false);
        }
    }

    async function syncWindowState() {
        await syncSearchWindowHeightMode();
        await syncMaximizedState();
        if (monitorHost.value) {
            viewportWidth.value = window.innerWidth;
            viewportHeight.value = window.innerHeight;
        }
        const generation = commitGeneration;
        try {
            const [monitor, position] = await Promise.all([
                currentMonitor(),
                monitorHost.value ? currentWindow.outerPosition() : Promise.resolve(null),
            ]);
            if (position && isCurrentGeometry(generation)) hostOrigin.value = position;
            if (monitor && isCurrentGeometry(generation)) {
                workAreaWidth.value = monitor.workArea.size.width;
                workAreaLeft.value = monitor.workArea.position.x;
                workAreaHeight.value = monitor.workArea.size.height;
                workAreaTop.value = monitor.workArea.position.y;
            }
        } catch (error) {
            reportError('read search window work area', error);
        }
    }

    async function syncSearchWindowAllowHeightOverride() {
        if (!options.ready.value) return;

        const allowHeightOverride = searchWindowHeightPolicy.value.allowHeightOverride;
        if (lastAllowHeightOverride === allowHeightOverride) return;

        await native.window.setSearchWindowAllowHeightOverride(allowHeightOverride);
        lastAllowHeightOverride = allowHeightOverride;
    }

    async function syncSearchWindowMinSizeConstraints() {
        if (!options.ready.value) return;

        const defaultSize = options.defaultSize.value;
        const constraints = resolveSearchWindowMinimumSize({
            defaultWidth: defaultSize.width,
            defaultHeight: defaultSize.height,
            hasManagedPanel: searchWindowHeightPolicy.value.hasManagedPanel,
            autoHeightFloor: Math.max(defaultSize.height, currentHeight.value || 0),
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
        logicalPanelResizeStart = null;
        isLogicalPanelResizing.value = false;
        const committed = await commitPanelHeight(options.defaultSize.value.height, {
            placement: 'idle',
            reset: true,
        });
        return committed && (await finishCompactTransition());
    }

    /** Measure the live content after Vue has applied the layout. */
    async function remeasureTargetHeight(): Promise<void> {
        const target = options.target.value;
        if (!target) return;

        await nextTick();
        if (measurementHold.value) return;
        if (isSurfaceAnimating.value) {
            scheduleMeasurement(target);
            return;
        }
        const nextHeight = resolveMeasuredPanelHeight(target);
        await commitPanelHeight(nextHeight);
    }

    function measureTargetHeight() {
        return options.target.value ? resolveMeasuredPanelHeight(options.target.value) : null;
    }

    // ---------------------------------------------------------------------
    // Session reveal
    // ---------------------------------------------------------------------
    async function playSessionExpandAnimation(height?: number) {
        const compactHeight = options.defaultSize.value.height;
        const target =
            height === undefined
                ? measureTargetHeight()
                : Math.min(
                      availablePanelHeight.value,
                      resolveAutoSessionPanelHeight({ searchBarHeight: compactHeight }),
                      Math.max(compactHeight, Math.ceil(height))
                  );
        if (target === null) return;

        await commitPanelHeight(target, { respectManualOverride: false });
    }

    async function collapseSessionToIdle() {
        const compactHeight = options.defaultSize.value.height;
        const fromHeight = currentHeight.value || compactHeight;
        if (fromHeight <= compactHeight + 1) {
            return finishCompactTransition();
        }

        const committed = await commitPanelHeight(compactHeight);
        if (!committed) return false;
        return finishCompactTransition();
    }

    async function finishCompactTransition() {
        const generation = commitGeneration;
        // Callers clear the conversation after this resolves; retain it throughout the fold.
        await cardAnimation.value?.finished.catch(() => undefined);
        return (
            isCurrentGeometry(generation) &&
            Math.abs(currentHeight.value - options.defaultSize.value.height) <= 1
        );
    }

    // ---------------------------------------------------------------------
    // Defaults, maximize, viewport
    // ---------------------------------------------------------------------
    async function syncSearchWindowDefaults() {
        if (!options.ready.value) return;

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
        if (!options.ready.value) return;

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
        const wasMaximized = desiredMaximized.value;
        const nextMaximized = !wasMaximized;
        const generation = claimGeometry();

        desiredMaximized.value = nextMaximized;
        isMaximizeTransitioning.value = true;
        logicalPanelResizeStart = null;
        isLogicalPanelResizing.value = false;

        try {
            await enqueueGeometry(generation, async () => {
                if (!monitorHost.value) {
                    if (nextMaximized) await ensureWindowMaximized(currentWindow);
                    else await ensureWindowRestoredFromMaximized(currentWindow);
                    return;
                }
                if (nextMaximized) {
                    await nextTick();
                    if (!isCurrentGeometry(generation)) return;
                    options.onLogicalPanelGeometryChange?.();
                }

                const from = {
                    width: currentWidth.value || options.defaultSize.value.width,
                    height: currentHeight.value || options.defaultSize.value.height,
                };
                const state = await native.window.commitSearchPanelResize({
                    from,
                    to: from,
                    auto: true,
                    placement: nextMaximized ? 'work-area' : 'restore',
                });
                if (isCurrentGeometry(generation)) {
                    applyState(state);
                }
            });
        } catch (error) {
            if (isCurrentGeometry(generation)) desiredMaximized.value = wasMaximized;
            throw error;
        } finally {
            if (isCurrentGeometry(generation)) {
                isMaximizeTransitioning.value = false;
                await syncViewportState(wasMaximized).catch((error) => {
                    reportError('sync viewport state after maximize toggle', error);
                });
                if (isCurrentGeometry(generation) && monitorHost.value) {
                    await nextTick();
                    options.onLogicalPanelGeometryChange?.();
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Manual panel resize (the drag handles)
    // ---------------------------------------------------------------------
    async function prepareForNativeDrag() {
        nativeDragLayout.value = { ...settledPanelStyle.value };
        viewportSyncScheduler.cancel();
        const generation = claimGeometry();
        return (
            (await enqueueGeometry(generation, async () => {
                const state = await native.window.getSearchWindowState();
                if (!isCurrentGeometry(generation)) return false;
                applyState(state);
                return true;
            })) ?? false
        );
    }

    async function finishNativeDrag() {
        try {
            await syncWindowState();
        } finally {
            nativeDragLayout.value = null;
            await nextTick();
            options.onHostViewportChange?.();
        }
    }

    function beginLogicalPanelResize(): LogicalSearchPanelSize {
        const generation = claimGeometry();
        logicalPanelResizeStart = {
            size: {
                width: currentWidth.value || options.defaultSize.value.width,
                height: currentHeight.value || options.defaultSize.value.height,
            },
            centerY: panelCenterY.value,
            heightMode: searchWindowHeightMode.value,
            generation,
        };
        isLogicalPanelResizing.value = true;
        return { ...logicalPanelResizeStart.size };
    }

    async function previewLogicalPanelResize(
        size: LogicalSearchPanelSize,
        physicalOrigin?: { x: number; y: number }
    ) {
        const start = logicalPanelResizeStart;
        if (
            !start ||
            !isCurrentGeometry(start.generation) ||
            !isLogicalPanelResizing.value ||
            !Number.isFinite(size.width) ||
            !Number.isFinite(size.height) ||
            size.width <= 0 ||
            size.height <= 0
        ) {
            return;
        }

        return enqueueGeometry(start.generation, async () => {
            const state = await native.window.commitSearchPanelResize({
                from: start.size,
                to: size,
                physicalOrigin: physicalOrigin
                    ? { x: physicalOrigin.x, y: hostOrigin.value.y }
                    : undefined,
                placement: 'preserve-origin',
            });
            if (!isCurrentGeometry(start.generation)) return;
            if (physicalOrigin) {
                panelCenterY.value =
                    (physicalOrigin.y + SEARCH_WINDOW_TOP_INSET - hostOrigin.value.y) /
                        scaleFactor() +
                    state.currentHeight / 2;
            }
            applyState(state);
            return state;
        });
    }

    async function commitLogicalPanelResize() {
        const start = logicalPanelResizeStart;
        if (!start) return;
        await enqueueGeometry(start.generation, async () => {
            if (logicalPanelResizeStart === start) {
                logicalPanelResizeStart = null;
                isLogicalPanelResizing.value = false;
                await syncSearchWindowMinSizeConstraints();
            }
        });
    }

    async function cancelLogicalPanelResize(physicalOrigin?: { x: number; y: number }) {
        const start = logicalPanelResizeStart;
        if (!start || !isCurrentGeometry(start.generation)) return;
        const generation = claimGeometry();
        try {
            await enqueueGeometry(generation, async () => {
                const state = await native.window.commitSearchPanelResize({
                    from: { width: currentWidth.value, height: currentHeight.value },
                    to: start.size,
                    physicalOrigin: physicalOrigin
                        ? { x: physicalOrigin.x, y: hostOrigin.value.y }
                        : undefined,
                    auto: start.heightMode === SearchWindowHeightMode.Auto,
                    respectManualOverride: false,
                    placement: 'preserve-origin',
                });
                if (isCurrentGeometry(generation)) {
                    applyState(state);
                    panelCenterY.value = start.centerY;
                }
            });
        } finally {
            if (isCurrentGeometry(generation)) {
                logicalPanelResizeStart = null;
                isLogicalPanelResizing.value = false;
            }
        }
    }

    // ---------------------------------------------------------------------
    // Watchers
    // ---------------------------------------------------------------------
    watch(
        options.target,
        (el) => {
            disposeObservers();
            if (el) {
                observeTarget(el);
            }
        },
        { immediate: true }
    );

    if (options.overlayTarget) {
        watch(
            options.overlayTarget,
            () => {
                const target = options.target.value;
                if (!target) return;

                observeTargetHeight(target);
                scheduleMeasurement(target);
            },
            { flush: 'post' }
        );
    }

    watch(
        () => options.quickSearchOpen.value,
        (open) => {
            if (!open) return;
            const target = options.target.value;
            if (!target) return;

            // The list is measured as soon as it renders; the host follows the
            // measurement like any other content change.
            scheduleMeasurement(target);
        },
        { flush: 'post' }
    );

    watch(
        () => [options.inputArea?.value, options.picker?.value],
        ([inputArea, picker]) => {
            inputResizeObserver?.disconnect();
            const measureInput = () => {
                inputAreaHeight.value =
                    inputArea?.getBoundingClientRect().height ?? options.defaultSize.value.height;
                pickerHeight.value = picker?.getBoundingClientRect().height ?? 0;
                scheduleMeasurement();
            };
            measureInput();
            inputResizeObserver = null;
            if (!inputArea && !picker) return;
            inputResizeObserver = new ResizeObserver(measureInput);
            if (inputArea) inputResizeObserver.observe(inputArea);
            if (picker) inputResizeObserver.observe(picker);
        },
        { immediate: true, flush: 'post' }
    );

    watch(
        () => options.ready.value,
        (ready) => {
            if (!ready) {
                claimGeometry();
                failedMeasurement = null;
                searchWindowResizeConstraintsReady.value = false;
                return;
            }

            void syncWindowState()
                .then(() => syncSearchWindowDefaults())
                .catch((error) => reportError('initialize search window geometry', error));
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
            if (!ready) return;
            if (
                previous &&
                previous.defaultWidth === defaultWidth &&
                previous.defaultHeight === defaultHeight
            ) {
                return;
            }

            void syncSearchWindowDefaults().catch((error) =>
                reportError('apply search window defaults', error)
            );
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
            if (!ready) return;

            void syncSearchWindowAllowHeightOverride().catch((error) =>
                reportError('sync search window override policy', error)
            );
            void syncSearchWindowMinSizeConstraints().catch((error) =>
                reportError('sync search window min size', error)
            );
        },
        { immediate: true, flush: 'post' }
    );

    watch(
        autoHeightEnabled,
        (enabled, previous) => {
            if (!enabled || enabled === previous) return;

            void remeasureTargetHeight().catch((error) =>
                reportError('remeasure surface after auto-height re-enabled', error)
            );
        },
        { flush: 'post' }
    );

    watch(measurementHold, (held) => {
        if (!held) scheduleMeasurement();
    });

    watch([availablePanelHeight, nativeDragLayout], () => {
        if (nativeDragLayout.value) return;
        // A smaller monitor can reduce host capacity; position-only movement cannot.
        if (monitorHost.value && currentHeight.value > availablePanelHeight.value) {
            void commitPanelHeight(currentHeight.value);
        } else scheduleMeasurement();
    });

    // ---------------------------------------------------------------------
    // Window listeners
    // ---------------------------------------------------------------------
    currentWindow
        .onResized(() => {
            notifyHostViewportChange();
            if (!options.ready.value) return;

            viewportSyncScheduler.schedule();
        })
        .then((unlisten) => {
            if (windowListenersDisposed) {
                unlisten();
                return;
            }
            unlistenWindowResize = unlisten;
        })
        .catch((error) => reportError('listen for window resize', error));

    currentWindow
        .onMoved(({ payload }) => {
            hostOrigin.value = payload;
            if (nativeDragLayout.value) return;
            viewportSyncScheduler.schedule();
            notifyHostViewportChange();
        })
        .then((unlisten) => {
            if (windowListenersDisposed) {
                unlisten();
                return;
            }
            unlistenWindowMoved = unlisten;
        })
        .catch((error) => reportError('listen for search window movement', error));

    currentWindow
        .onScaleChanged(({ payload }) => {
            displayScaleFactor.value = payload.scaleFactor;
            viewportSyncScheduler.schedule();
            notifyHostViewportChange();
        })
        .then((unlisten) => {
            if (windowListenersDisposed) {
                unlisten();
                return;
            }
            unlistenWindowScaleChanged = unlisten;
        })
        .catch((error) => reportError('listen for window scale changes', error));

    onUnmounted(() => {
        windowListenersDisposed = true;
        claimGeometry();
        disposeObservers();
        inputResizeObserver?.disconnect();
        inputResizeObserver = null;
        viewportSyncScheduler.cancel();
        unlistenWindowResize?.();
        unlistenWindowResize = null;
        unlistenWindowMoved?.();
        unlistenWindowMoved = null;
        unlistenWindowScaleChanged?.();
        unlistenWindowScaleChanged = null;
    });

    return {
        contentReady,
        currentHeight,
        cardHeight,
        measurementHold,
        isMaximized: desiredMaximized,
        effectiveWindowMaximized,
        settledWindowMaximized,
        fillConversationAvailableHeight,
        skillPickerMaxHeight,
        filePickerMaxHeight,
        monitorHost,
        panelBounds,
        overlayMinViewportLeft: computed(() =>
            monitorHost.value ? visibleViewport.value.left : undefined
        ),
        overlayMaxViewportRight: computed(() =>
            monitorHost.value ? visibleViewport.value.right : undefined
        ),
        overlayMinViewportTop: computed(() =>
            monitorHost.value ? visibleViewport.value.top : undefined
        ),
        overlayMaxViewportHeight: computed(() =>
            monitorHost.value
                ? Math.max(
                      visibleViewport.value.top,
                      Math.min(
                          panelBounds.value.bottom,
                          visibleViewport.value.bottom - SEARCH_WINDOW_VISUAL_OUTSET
                      )
                  )
                : undefined
        ),
        panelStyle,
        cardStyle,
        isSessionExpandAnimating: isSurfaceAnimating,
        isCardGrowing,
        isLogicalPanelResizing,
        allowLogicalPanelHeightResize: computed(
            () => searchWindowHeightPolicy.value.allowHeightOverride
        ),
        toggleMaximize,
        syncWindowState,
        remeasureTargetHeight,
        measureTargetHeight,
        scheduleMeasurement,
        playSessionExpandAnimation,
        collapseSessionToIdle,
        resetSearchWindowBounds,
        beginLogicalPanelResize,
        previewLogicalPanelResize,
        commitLogicalPanelResize,
        cancelLogicalPanelResize,
        prepareForNativeDrag,
        finishNativeDrag,
    };
}
