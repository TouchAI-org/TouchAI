// Copyright (c) 2026. 閸楀啳鐦? Licensed under GPL v3.

import { useMotion } from '@composables/useMotion';
import { native } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { cubicBezier } from 'motion-v';
import { computed, nextTick, onUnmounted, type Ref, ref, shallowRef, watch } from 'vue';

import {
    SEARCH_SURFACE_EASING,
    SEARCH_SURFACE_MOTION,
    type SearchWindowDefaultSize,
    SearchWindowHeightMode,
} from '@/config/searchWindow';
import {
    resolveContentPanelHeight,
    resolveSurfaceHostContentHeight,
    resolveSurfacePanelStyle,
    resolveSurfaceWorkAreaHeight,
    shouldCommitPanelHeight,
} from '@/views/SearchView/searchSurfaceLayout';
import {
    resolveFrameShiftForGrowth,
    resolveSurfaceFrameY,
    resolveSurfaceGeometryMode,
    type SurfaceGeometryMode,
    surfaceModeCentres,
} from '@/views/SearchView/surfaceGeometry';
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
    target: Ref<HTMLElement | null>;
    /** Read natural content independently of the viewport that clips it. */
    measureContentHeight?: (target: HTMLElement) => number;
    overlayTarget?: Ref<HTMLElement | null>;
    card?: Ref<HTMLElement | null>;
    overlayRequiredViewportHeight?: Ref<number | null>;
    /**
     * True while a popup is open *over* the surface (model picker, session history).
     *
     * The element and viewport-height refs above are filled in once the popup has been measured, so
     * the growth that opens it can reach a commit before either of them is set. This one is the
     * surface's own state and is true from the moment the popup opens.
     */
    overlayOpen?: Readonly<Ref<boolean>>;
    intrinsicHeightMeasurementPending?: Readonly<Ref<boolean>>;
    sessionCount: Ref<number>;
    quickSearchOpen: Ref<boolean>;
    defaultSize: Ref<SearchWindowDefaultSize>;
    ready: Ref<boolean>;
    onLogicalPanelHeightChange?: (height: number) => void;
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
}

/** Coalesce observer bursts without delaying the native clipping boundary. */
const MEASURE_COALESCE_MS = 16;

const easeHostShift = cubicBezier(...SEARCH_SURFACE_MOTION.easing);

/** One serialized geometry owner coordinates native bounds and the visible card. */
export function useSearchWindowResize(options: UseSearchWindowResizeOptions) {
    const currentWindow = getCurrentWindow();
    const { reducedMotion, duration: motionDuration } = useMotion();

    const currentWidth = ref(0);
    const currentHeight = ref(0);
    const currentHostContentHeight = ref<number | null>(null);
    const activeHeightChange = shallowRef<HeightChange | null>(null);
    const cardAnimation = shallowRef<Animation | null>(null);
    // Hold the previous layout until native bounds can contain the next frame.
    const cardHeight = computed(() => activeHeightChange.value?.fromHeight ?? currentHeight.value);
    const monitorHost = ref(false);
    const desiredMaximized = ref(false);
    const isMaximizeTransitioning = ref(false);
    const isLogicalPanelResizing = ref(false);
    const displayScaleFactor = ref(window.devicePixelRatio);
    const workAreaHeight = ref<number | null>(null);
    const availablePanelHeight = computed(() =>
        monitorHost.value && workAreaHeight.value !== null
            ? resolveSurfaceWorkAreaHeight(workAreaHeight.value, scaleFactor())
            : Number.POSITIVE_INFINITY
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
        duration: number
    ): Animation | null {
        const card = options.card?.value ?? null;
        if (!card || typeof card.animate !== 'function') return null;
        if (duration <= 0 || Math.abs(fromHeight - toHeight) < 1) return null;

        return card.animate([{ height: `${fromHeight}px` }, { height: `${toHeight}px` }], {
            duration,
            easing: SEARCH_SURFACE_EASING,
            fill: 'both',
        });
    }
    /**
     * Held while a QuickSearch list is folding into a conversation.
     *
     * The list still occupies part of the layout while it folds, so measuring then would add
     * the fading results to the conversation and commit a transient sum. The fold ends with one
     * measurement of the conversation alone.
     */
    const measurementHold = ref(false);

    /** Move the native frame on the same curve as the card to preserve its centre. */
    let hostShiftFrame: number | null = null;
    /** Invalidates frame callbacks and position reads that cancellation cannot abort. */
    let hostShiftToken = 0;
    let hostPositionWrite: Promise<void> | null = null;
    /** Derive absolute targets from the compact origin so repeated measurements cannot accumulate drift. */
    let hostIdleOrigin: { x: number; y: number } | null = null;
    /** Last confirmed position; native movement updates it when no programmatic drift owns the frame. */
    let hostAnchor: { x: number; y: number } | null = null;
    /** Newest origin read; an older one must not write the cached origin. */
    let originSeedToken = 0;
    /** Popups hold the frame still; conversation growth may move its centre. */
    let geometryMode: SurfaceGeometryMode = 'idle';
    /** Frame position when a popup took the layout over; the frame holds it until it closes. */
    let frozenOriginY: number | null = null;

    /** Placements outside the drift invalidate both its reference and its starting point. */
    function invalidateHostAnchor() {
        originSeedToken += 1;
        hostAnchor = null;
        hostIdleOrigin = null;
    }

    /** Remember where the frame rests at the idle height, and where it is right now. */
    function recordIdleOrigin(position: { x: number; y: number }) {
        hostIdleOrigin = {
            x: position.x,
            y:
                position.y -
                resolveFrameShiftForGrowth(
                    currentHeight.value || options.defaultSize.value.height,
                    options.defaultSize.value.height,
                    scaleFactor()
                ),
        };
        hostAnchor = { x: position.x, y: position.y };
    }

    /** Read the frame's origin and remember it as the idle origin. */
    function seedIdleOrigin() {
        // A read can come back after the frame was moved again. Only the seed that is still the
        // newest one may write the origin, otherwise a stale position becomes the base every later
        // reveal is derived from.
        const seed = ++originSeedToken;
        void currentWindow
            .outerPosition()
            .then((position) => {
                if (windowListenersDisposed || hostShiftFrame !== null || hostPositionWrite) return;
                if (seed !== originSeedToken) return;
                recordIdleOrigin(position);
            })
            .catch((error) => reportError('read the search host position', error));
    }

    function cancelHostShift() {
        hostShiftToken += 1;
        if (hostShiftFrame !== null) {
            cancelAnimationFrame(hostShiftFrame);
            hostShiftFrame = null;
        }
    }

    function writeHostPosition(x: number, y: number, generation: number, token: number) {
        const previous = hostPositionWrite;
        const write = (async () => {
            await previous;
            if (!isCurrentGeometry(generation) || token !== hostShiftToken) return;
            await currentWindow.setPosition(new PhysicalPosition(x, y));
            // Tauri's setter only queues a main-thread message. A read waits for it to apply.
            const position = await currentWindow.outerPosition();
            if (isCurrentGeometry(generation) && token === hostShiftToken) {
                hostAnchor = position;
            }
        })();
        hostPositionWrite = write;
        const release = () => {
            if (hostPositionWrite === write) hostPositionWrite = null;
        };
        void write.then(release, release);
        return write;
    }

    /** Read once per transition: native resize may already have clamped the host to this monitor. */
    async function readSurfaceFrame(targetY: number | null, generation: number) {
        if (targetY === null || !monitorHost.value || desiredMaximized.value) return null;
        const token = hostShiftToken;
        try {
            const [monitor, position, size] = await Promise.all([
                currentMonitor(),
                currentWindow.outerPosition(),
                currentWindow.outerSize(),
            ]);
            if (!monitor || !isCurrentGeometry(generation) || token !== hostShiftToken) return null;
            const { position: areaOrigin, size: areaSize } = monitor.workArea;
            const maxX = Math.max(areaOrigin.x, areaOrigin.x + areaSize.width - size.width);
            const maxY = Math.max(areaOrigin.y, areaOrigin.y + areaSize.height - size.height);
            hostAnchor = position;
            return {
                x: Math.max(areaOrigin.x, Math.min(position.x, maxX)),
                fromY: position.y,
                toY: Math.max(areaOrigin.y, Math.min(targetY, maxY)),
            };
        } catch (error) {
            reportError('read the search host work area', error);
            return null;
        }
    }

    /** Start both motion tracks in the same task, after their native bounds are known. */
    function applySurfaceFrame(
        frame: Awaited<ReturnType<typeof readSurfaceFrame>>,
        animate: boolean,
        generation: number
    ) {
        if (!frame || !isCurrentGeometry(generation)) return;
        cancelHostShift();
        if (frame.fromY === frame.toY && frame.x === hostAnchor?.x) return;
        if (!animate || reducedMotion.value || SEARCH_SURFACE_MOTION.durationMs <= 0) {
            void writeHostPosition(frame.x, frame.toY, generation, hostShiftToken).catch((error) =>
                reportError('place the search host', error)
            );
            return;
        }
        runHostShift(
            frame.x,
            frame.fromY,
            frame.toY,
            motionDuration(SEARCH_SURFACE_MOTION.durationMs - SEARCH_SURFACE_MOTION.hostLeadMs),
            generation
        );
    }

    function runHostShift(
        x: number,
        fromY: number,
        toY: number,
        duration: number,
        generation: number
    ) {
        const token = hostShiftToken;
        const startedAt = performance.now();
        let applied: number | null = null;
        const step = async () => {
            if (!isCurrentGeometry(generation) || token !== hostShiftToken) return;
            const progress = reducedMotion.value
                ? 1
                : Math.min(1, (performance.now() - startedAt) / duration);
            const y = Math.round(fromY + (toY - fromY) * easeHostShift(progress));
            if (y !== applied) {
                applied = y;
                await writeHostPosition(x, y, generation, token).catch((error) =>
                    reportError('move the search host', error)
                );
            }
            if (!isCurrentGeometry(generation) || token !== hostShiftToken) return;
            hostShiftFrame = progress < 1 ? requestAnimationFrame(step) : null;
        };
        hostShiftFrame = requestAnimationFrame(step);
    }

    /** Subpixel height updates still need the absolute frame position once motion has settled. */
    function snapHostToHeight(height: number) {
        if (!monitorHost.value || desiredMaximized.value) return;
        if (hostShiftFrame !== null || hostPositionWrite !== null || cardAnimation.value !== null)
            return;
        const generation = commitGeneration;
        void readSurfaceFrame(
            resolveSurfaceFrameY({
                mode: geometryMode,
                panelHeight: height,
                compactHeight: options.defaultSize.value.height,
                scaleFactor: scaleFactor(),
                idleOriginY: hostIdleOrigin?.y ?? null,
                frozenOriginY,
            }),
            generation
        ).then((frame) => applySurfaceFrame(frame, false, generation));
    }

    function cancelCardAnimation(animation = cardAnimation.value) {
        if (animation === cardAnimation.value) cardAnimation.value = null;
        animation?.cancel();
    }

    function claimGeometry() {
        const generation = ++commitGeneration;
        originSeedToken += 1;
        isMaximizeTransitioning.value = false;
        cancelCardAnimation();
        cancelHostShift();
        activeHeightChange.value = null;
        return generation;
    }

    function isCurrentGeometry(generation: number) {
        return !windowListenersDisposed && generation === commitGeneration;
    }

    function enqueueGeometry<T>(generation: number, operation: () => Promise<T>) {
        const run = commitQueue.then(async () => {
            await hostPositionWrite?.catch(() => undefined);
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
        const target = options.target.value;
        if (target && settled) scheduleMeasurement(target);
    }

    /** Height the card is showing right now, in CSS pixels. */
    function currentCardHeight(): number {
        const card = options.card?.value;
        const height = card?.getBoundingClientRect().height ?? 0;
        return height > 0 ? height : currentHeight.value;
    }

    /** Start card and host motion together; neither samples the other track?s previous frame. */
    async function startCardAnimation(
        fromHeight: number,
        toHeight: number,
        generation: number,
        animateFrame: boolean,
        frameMode: SurfaceGeometryMode
    ) {
        const frame = await readSurfaceFrame(
            resolveSurfaceFrameY({
                mode: frameMode,
                panelHeight: toHeight,
                compactHeight: options.defaultSize.value.height,
                scaleFactor: scaleFactor(),
                idleOriginY: hostIdleOrigin?.y ?? null,
                frozenOriginY,
            }),
            generation
        );
        if (!isCurrentGeometry(generation)) return null;
        cardAnimation.value = animateCardHeight(
            fromHeight,
            toHeight,
            motionDuration(SEARCH_SURFACE_MOTION.durationMs)
        );
        applySurfaceFrame(frame, animateFrame, generation);
        return cardAnimation.value;
    }
    const isCardGrowing = computed(() => cardAnimation.value !== null);
    watch(reducedMotion, (reduced) => {
        // Resolve the existing completion promise so shrink commits and reveal cleanup still run.
        if (reduced) cardAnimation.value?.finish();
    });

    const searchWindowHeightPolicy = computed(() =>
        resolveSearchWindowHeightPolicy({
            sessionCount: options.sessionCount.value,
            quickSearchOpen: options.quickSearchOpen.value,
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

    /** The visible panel always fills the native host interior. */
    const panelStyle = computed(() => {
        if (!monitorHost.value) {
            return undefined;
        }

        return {
            position: 'fixed' as const,
            ...resolveSurfacePanelStyle({
                scaleFactor: displayScaleFactor.value,
                maximized: effectiveWindowMaximized.value,
            }),
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
    let mutationObserver: MutationObserver | null = null;
    let unlistenWindowResize: (() => void) | null = null;
    let unlistenWindowMoved: (() => void) | null = null;
    let unlistenWindowScaleChanged: (() => void) | null = null;
    let measureTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingMeasureTarget: HTMLElement | null = null;
    let failedMeasurement: { panelHeight: number; hostContentHeight: number | null } | null = null;
    let logicalPanelResizeStart: {
        size: LogicalSearchPanelSize;
        heightMode: SearchWindowHeightMode;
        generation: number;
    } | null = null;

    const viewportSyncScheduler = createWindowViewportSyncScheduler(syncViewportState, 80);

    function reportError(action: string, error: unknown) {
        log.error(`[SearchView] Failed to ${action}:`, error);
    }

    function notifyHostViewportChange() {
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

    function resolveHostContentHeight(panelHeight: number) {
        if (!monitorHost.value) return null;

        // Only a rendered overlay reserves an envelope past the panel bottom.
        // Without one there is nothing to reserve, and recomputing a value would
        // keep re-committing the same envelope forever.
        const overlayTarget = options.overlayTarget?.value ?? null;
        const overlayRequiredViewportHeight = options.overlayRequiredViewportHeight?.value ?? null;
        if (!overlayTarget && overlayRequiredViewportHeight === null) return null;

        return Math.min(
            availablePanelHeight.value + SEARCH_WINDOW_TOP_INSET / scaleFactor(),
            resolveSurfaceHostContentHeight({
                panelHeight,
                overlayBottom: overlayTarget?.getBoundingClientRect().bottom ?? null,
                overlayRequiredViewportHeight,
                scaleFactor: scaleFactor(),
            })
        );
    }

    function resolveHostContentHeightPayload(panelHeight: number) {
        const hostContentHeight = resolveHostContentHeight(panelHeight);
        if (hostContentHeight === null) return undefined;

        const panelBottom = resolveSurfaceHostContentHeight({
            panelHeight,
            overlayBottom: null,
            overlayRequiredViewportHeight: null,
            scaleFactor: scaleFactor(),
        });

        return hostContentHeight > panelBottom ? hostContentHeight : undefined;
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
        currentHostContentHeight.value = state.hostContentHeight ?? null;
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
            /** Center the surface in its own motion, whatever else owns the layout. */
            center?: boolean;
        } = {}
    ) {
        if (windowListenersDisposed || !options.ready.value) {
            return;
        }
        if (options.resizeEnabled?.value === false && !commitOptions.reset) return;
        if (effectiveWindowMaximized.value && !commitOptions.reset) return;
        if (isLogicalPanelResizing.value && !commitOptions.reset) return;

        const from = {
            width: currentWidth.value || options.defaultSize.value.width,
            height: currentHeight.value || options.defaultSize.value.height,
        };
        const respectManualOverride =
            commitOptions.respectManualOverride ??
            searchWindowHeightPolicy.value.respectManualOverride;
        const target = resolveEffectivePanelHeight(panelHeight, commitOptions);
        const hostContentHeight = commitOptions.reset
            ? undefined
            : resolveHostContentHeightPayload(target);
        const hostContentChanged = (hostContentHeight ?? null) !== currentHostContentHeight.value;
        const heightChanged = shouldCommitPanelHeight({
            current: activeHeightChange.value?.toHeight ?? from.height,
            next: target,
        });
        if (!commitOptions.placement && !heightChanged && !hostContentChanged) return;

        const envelopeOnly = !heightChanged && !commitOptions.placement;
        const revealFrom = Math.max(
            1,
            cardAnimation.value
                ? currentCardHeight()
                : (activeHeightChange.value?.fromHeight ?? currentCardHeight())
        );
        const generation = envelopeOnly ? commitGeneration : claimGeometry();
        const wasMaximized = desiredMaximized.value;
        if (commitOptions.reset) desiredMaximized.value = false;
        if (!envelopeOnly) {
            activeHeightChange.value = {
                fromHeight: revealFrom,
                toHeight: target,
            };
        }
        const change = envelopeOnly ? null : activeHeightChange.value;
        // Resolve placement from the content mode before either motion track starts.
        const popupOpen =
            (options.overlayOpen?.value ?? false) ||
            Boolean(options.overlayTarget?.value) ||
            (options.overlayRequiredViewportHeight?.value ?? null) !== null;
        const nextMode = resolveSurfaceGeometryMode({
            panelHeight: target,
            compactHeight: options.defaultSize.value.height,
            popupOpen,
            maximized: effectiveWindowMaximized.value,
            manualOverride: searchWindowHeightMode.value === SearchWindowHeightMode.ManualOverride,
        });
        const previousMode = geometryMode;
        const previousFrozenOriginY = frozenOriginY;
        if (nextMode === 'popup' && geometryMode !== 'popup') {
            // Remember where the frame was when the popup took over: that is where it has to stay
            // until the popup is gone, whatever the host envelope does in the meantime.
            frozenOriginY = hostAnchor?.y ?? null;
        }
        geometryMode = nextMode;
        const atIdleHeight = nextMode === 'idle' && monitorHost.value && !desiredMaximized.value;
        const placement = commitOptions.placement ?? (atIdleHeight ? 'idle' : 'preserve-origin');
        // A conversation asks for the centring explicitly; otherwise only the mode decides.
        const centreFrame = Boolean(commitOptions.center) || surfaceModeCentres(nextMode);
        const frameMode = commitOptions.center ? 'surface' : nextMode;
        const animatesCard = !envelopeOnly && Math.abs(revealFrom - target) > 1;
        const shrinks = animatesCard && revealFrom > target;

        await enqueueGeometry(generation, async () => {
            let animation: Animation | null = null;
            let revealContinues = false;
            let nativeCommitted = false;
            const previousOrigin = hostAnchor;
            try {
                if (shrinks) {
                    animation = await startCardAnimation(
                        revealFrom,
                        target,
                        generation,
                        centreFrame,
                        frameMode
                    );
                    await animation?.finished.catch(() => undefined);
                    if (!isCurrentGeometry(generation)) return;
                }
                if (monitorHost.value) {
                    const state = commitOptions.reset
                        ? await native.window
                              .resetSearchWindowBounds()
                              .then(() => native.window.getSearchWindowState())
                        : await native.window.commitSearchPanelResize({
                              from,
                              to: { width: from.width, height: target },
                              auto: true,
                              ...(hostContentHeight === undefined ? {} : { hostContentHeight }),
                              ...(commitOptions.respectManualOverride === undefined
                                  ? {}
                                  : { respectManualOverride: commitOptions.respectManualOverride }),
                              placement,
                          });
                    if (!isCurrentGeometry(generation)) return;
                    applyState(state);
                    nativeCommitted = true;
                    failedMeasurement = null;
                    if (!envelopeOnly && placement !== 'preserve-origin') {
                        cancelHostShift();
                        invalidateHostAnchor();
                        seedIdleOrigin();
                    }
                    if (animatesCard && !shrinks) {
                        animation = await startCardAnimation(
                            revealFrom,
                            state.currentHeight,
                            generation,
                            centreFrame,
                            frameMode
                        );
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
                    if (!isCurrentGeometry(generation)) return;
                    const state = await native.window.getSearchWindowState();
                    if (!isCurrentGeometry(generation)) return;
                    applyState(state);
                    nativeCommitted = true;
                    failedMeasurement = null;
                    currentHostContentHeight.value = null;
                }
                if (change) {
                    if (activeHeightChange.value === change) activeHeightChange.value = null;
                    await nextTick();
                    if (!isCurrentGeometry(generation)) return;
                    if (animation && !shrinks) {
                        const reveal = animation;
                        revealContinues = true;
                        void reveal.finished
                            .catch(() => undefined)
                            .then(() => finishCardTransition(change, generation, reveal));
                    }
                }
                await syncSearchWindowMinSizeConstraints();
            } catch (error) {
                reportError('commit search panel height', error);
                if (!nativeCommitted && isCurrentGeometry(generation)) {
                    failedMeasurement = {
                        panelHeight: target,
                        hostContentHeight: hostContentHeight ?? null,
                    };
                    if (commitOptions.reset) desiredMaximized.value = wasMaximized;
                    cancelHostShift();
                    geometryMode = previousMode;
                    frozenOriginY = previousFrozenOriginY;
                    if (previousOrigin) {
                        await writeHostPosition(
                            previousOrigin.x,
                            previousOrigin.y,
                            generation,
                            hostShiftToken
                        ).catch((restoreError) =>
                            reportError('restore the search host position', restoreError)
                        );
                    }
                }
            } finally {
                if (change && !revealContinues) {
                    finishCardTransition(change, generation, animation, nativeCommitted);
                    if (isCurrentGeometry(generation)) snapHostToHeight(currentHeight.value);
                }
            }
        });
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

        // A content-bounded native host carries the overlay envelope itself
        // (`hostContentHeight`), so the panel stays a pure function of the measured
        // content. Without such a host nothing else can grow, so the envelope has
        // to be folded into the panel height.
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
            if (measurementHold.value) return;
            if (!target || windowListenersDisposed || !autoHeightEnabled.value) {
                return;
            }

            const nextHeight = resolveEffectivePanelHeight(resolveMeasuredPanelHeight(target));
            // Rolling back an animation fires ResizeObserver too. Only a changed target
            // or an explicit remeasurement should retry a failed native operation.
            if (
                failedMeasurement?.panelHeight === nextHeight &&
                failedMeasurement.hostContentHeight ===
                    (resolveHostContentHeightPayload(nextHeight) ?? null)
            )
                return;
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
            const generation = commitGeneration;
            try {
                const monitor = await currentMonitor();
                if (monitor && isCurrentGeometry(generation))
                    workAreaHeight.value = monitor.workArea.size.height;
            } catch (error) {
                reportError('read search window work area', error);
            }
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
        await commitPanelHeight(options.defaultSize.value.height, {
            placement: 'idle',
            reset: true,
        });
    }

    /** Measure the live content after Vue has applied the layout. */
    async function remeasureTargetHeight(): Promise<void> {
        const target = options.target.value;
        if (!target) return;

        await nextTick();
        if (measurementHold.value) return;
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

        await commitPanelHeight(target, { respectManualOverride: false, center: true });
    }

    async function collapseSessionToIdle() {
        const compactHeight = options.defaultSize.value.height;
        const fromHeight = currentHeight.value || compactHeight;
        if (fromHeight <= compactHeight + 1) {
            return false;
        }

        await commitPanelHeight(compactHeight, { center: true });
        return true;
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
                const hostContentHeight = nextMaximized
                    ? undefined
                    : resolveHostContentHeightPayload(from.height);
                const state = await native.window.commitSearchPanelResize({
                    from,
                    to: from,
                    auto: true,
                    placement: nextMaximized ? 'work-area' : 'restore',
                    ...(hostContentHeight === undefined ? {} : { hostContentHeight }),
                });
                if (isCurrentGeometry(generation)) {
                    applyState(state);
                    invalidateHostAnchor();
                    seedIdleOrigin();
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
        const generation = claimGeometry();
        return (
            (await enqueueGeometry(generation, async () => {
                const state = await native.window.getSearchWindowState();
                if (!isCurrentGeometry(generation)) return false;
                applyState(state);
                invalidateHostAnchor();
                seedIdleOrigin();
                return true;
            })) ?? false
        );
    }

    function beginLogicalPanelResize(): LogicalSearchPanelSize {
        const generation = claimGeometry();
        logicalPanelResizeStart = {
            size: {
                width: currentWidth.value || options.defaultSize.value.width,
                height: currentHeight.value || options.defaultSize.value.height,
            },
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
                physicalOrigin,
                placement: 'preserve-origin',
            });
            if (!isCurrentGeometry(start.generation)) return;
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
                invalidateHostAnchor();
                seedIdleOrigin();
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
                    physicalOrigin,
                    auto: start.heightMode === SearchWindowHeightMode.Auto,
                    respectManualOverride: false,
                    placement: 'preserve-origin',
                });
                if (isCurrentGeometry(generation)) applyState(state);
            });
        } finally {
            if (isCurrentGeometry(generation)) {
                logicalPanelResizeStart = null;
                isLogicalPanelResizing.value = false;
                invalidateHostAnchor();
                seedIdleOrigin();
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

    watch(availablePanelHeight, () => scheduleMeasurement());

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
            // Only track the frame when no drift owns it: the drift writes its own position
            // every frame and its echo must not become the next anchor.
            if (hostShiftFrame === null && hostPositionWrite === null) {
                recordIdleOrigin(payload);
                viewportSyncScheduler.schedule();
            }
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

    // Seed the drift origins so the first reveal does not have to wait for a position read.
    seedIdleOrigin();

    currentWindow
        .onScaleChanged(({ payload }) => {
            displayScaleFactor.value = payload.scaleFactor;
            // Every drift target is computed in physical pixels from the scale it captured, so a
            // scale that changed mid-flight leaves the frame on a position nothing will correct.
            cancelHostShift();
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
        hostContentHeight: currentHostContentHeight,
        isMaximized: desiredMaximized,
        effectiveWindowMaximized,
        settledWindowMaximized,
        fillConversationAvailableHeight,
        monitorHost,
        overlayMaxViewportHeight: computed(() =>
            Number.isFinite(availablePanelHeight.value)
                ? availablePanelHeight.value + SEARCH_WINDOW_TOP_INSET / scaleFactor()
                : undefined
        ),
        panelStyle,
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
    };
}
