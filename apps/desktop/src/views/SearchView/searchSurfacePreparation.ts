import { useStateMachine } from 'reka-ui';
import { nextTick } from 'vue';

import type { SearchSurfaceHiddenEvent, SearchSurfaceShownEvent } from '@/app/api/search/events';
import type {
    SearchSurfacePhysicalViewport,
    SearchSurfacePreparation,
} from '@/app/api/windows/contracts';
import { isMacPlatform } from '@/utils/shortcuts';

type Unlisten = () => void;
type SearchSurfacePreparationIdentity = Pick<
    SearchSurfacePreparation,
    'rendererEpoch' | 'showEpoch' | 'hostEpoch'
>;

export interface SearchSurfaceViewportSnapshot {
    physicalViewport: SearchSurfacePhysicalViewport;
    scaleFactor: number;
}

/**
 * `superseded` means the host had already replaced the preparation this commit
 * described. Retrying the same token can never succeed, so the attempt ends and
 * the newer preparation drives the next one.
 */
export type SearchSurfaceFlushOutcome = 'committed' | 'superseded' | 'failed';

export interface SearchSurfacePreparationControllerOptions {
    listenPrepare: (
        handler: (payload: SearchSurfacePreparation) => void | Promise<void>
    ) => Promise<Unlisten>;
    listenShown: (
        handler: (payload: SearchSurfaceShownEvent) => void | Promise<void>
    ) => Promise<Unlisten>;
    listenHidden: (
        handler: (payload: SearchSurfaceHiddenEvent) => void | Promise<void>
    ) => Promise<Unlisten>;
    getRendererEpoch: () => Promise<number>;
    markRendererReady: (rendererEpoch: number) => Promise<SearchSurfacePreparation | null>;
    getViewport: () => Promise<SearchSurfaceViewportSnapshot>;
    /**
     * Content work that must finish before the surface is measured, such as
     * dropping a session that outlived the hide timeout. The window is still
     * hidden here, so whatever this does cannot be watched by the user.
     */
    beforeMeasure?: (isCurrent: () => boolean) => void | Promise<void>;
    /**
     * Ask the host to publish a fresh preparation for its current frame. Needed
     * when the measured viewport no longer matches the preparation: the host
     * resized while hidden, so the epoch that was sent can never be committed.
     */
    requestHostRefresh?: () => Promise<void>;
    settle: (waitForPaint: boolean) => Promise<void>;
    flush: (preparation: SearchSurfacePreparation) => Promise<SearchSurfaceFlushOutcome>;
    onShown: (payload: SearchSurfaceShownEvent) => void | Promise<void>;
    onHidden: (payload: SearchSurfaceHiddenEvent) => void | Promise<void>;
    onError?: (error: unknown) => void;
}

export interface SearchSurfacePreparationController {
    start: () => Promise<boolean>;
    notifyViewportChanged: () => void;
    dispose: () => void;
}

function createSubscriptionOwner() {
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const unlisteners: Unlisten[] = [];
    return {
        lifecycle: useStateMachine('pending', {
            pending: { activate: 'active', fail: 'failed', dispose: 'disposed' },
            active: { dispose: 'disposed' },
            failed: {},
            disposed: {},
        }),
        ready,
        resolveReady,
        rejectReady,
        unlisteners,
    };
}

type SubscriptionOwner = ReturnType<typeof createSubscriptionOwner>;

export function createSearchSurfacePreparationController(
    options: SearchSurfacePreparationControllerOptions
): SearchSurfacePreparationController {
    let disposed = false;
    let cancellationEpoch = 0;
    let intentEpoch = 0;
    let attemptEpoch = 0;
    let commitRetries = 0;
    // A viewport mismatch means the host frame moved under us. One refresh per
    // preparation is enough; a second mismatch is a real fault.
    let refreshRequests = 0;
    let pendingPreparation: SearchSurfacePreparation | null = null;
    let latestShownPreparation: SearchSurfacePreparationIdentity | null = null;
    let pendingCommit: {
        promise: Promise<boolean>;
        resolve: (committed: boolean) => void;
        settled: boolean;
    } | null = null;
    let subscriptionOwner: SubscriptionOwner | undefined;

    function ownsSubscriptions(owner: SubscriptionOwner) {
        return (
            !disposed &&
            subscriptionOwner === owner &&
            (owner.lifecycle.state.value === 'pending' || owner.lifecycle.state.value === 'active')
        );
    }

    async function listenForOwner<Payload>(
        owner: SubscriptionOwner,
        listen: (handler: (payload: Payload) => void | Promise<void>) => Promise<Unlisten>,
        handler: (payload: Payload) => void | Promise<void>
    ) {
        if (!ownsSubscriptions(owner)) return;
        const unlisten = await listen((payload) => {
            if (!ownsSubscriptions(owner)) return;
            return handler(payload);
        });
        if (!ownsSubscriptions(owner)) {
            unlisten();
            return;
        }
        owner.unlisteners.push(unlisten);
    }

    function releaseSubscriptions(owner: SubscriptionOwner) {
        for (const unlisten of owner.unlisteners.splice(0)) unlisten();
    }

    function resolvePendingCommit(committed: boolean) {
        if (!pendingCommit || pendingCommit.settled) return;
        pendingCommit.settled = true;
        pendingCommit.resolve(committed);
    }

    function finishPreparation(committed: boolean) {
        resolvePendingCommit(committed);
        pendingCommit = null;
        intentEpoch += 1;
        attemptEpoch += 1;
        commitRetries = 0;
        refreshRequests = 0;
        pendingPreparation = null;
    }

    function invalidatePreparation() {
        finishPreparation(false);
    }

    function confirmPreparationShown(payload: SearchSurfaceShownEvent) {
        if (!latestShownPreparation || comparePreparation(payload, latestShownPreparation) > 0) {
            latestShownPreparation = payload;
        }
        finishPreparation(true);
    }

    function isCurrent(
        preparation: SearchSurfacePreparation,
        capturedIntent: number,
        capturedAttempt: number
    ) {
        return (
            !disposed &&
            capturedIntent === intentEpoch &&
            capturedAttempt === attemptEpoch &&
            pendingPreparation === preparation
        );
    }

    function waitForSupersedingPreparation(): Promise<void> {
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    /**
     * A mismatching viewport is normally transient: the renderer catches up and
     * `notifyViewportChanged` retries. Waiting is the contract. But when the host
     * frame itself moved while hidden, no later viewport will ever match that
     * preparation, so ask the host once for a fresh one. A refresh that fails is
     * a real fault: the show cannot complete and the attempt must not hang.
     */
    async function requestFreshPreparation(isAttemptCurrent: () => boolean) {
        if (!isAttemptCurrent()) return;
        if (!options.requestHostRefresh || refreshRequests >= 1) return;
        refreshRequests += 1;
        try {
            await options.requestHostRefresh();
        } catch (error) {
            if (!isAttemptCurrent()) return;
            resolvePendingCommit(false);
            options.onError?.(error);
        }
    }

    function attemptPreparation() {
        const preparation = pendingPreparation;
        if (!preparation || disposed) return;

        const capturedIntent = intentEpoch;
        const capturedAttempt = ++attemptEpoch;
        void (async () => {
            const isAttemptCurrent = () => isCurrent(preparation, capturedIntent, capturedAttempt);
            await options.beforeMeasure?.(isAttemptCurrent);
            if (!isAttemptCurrent()) return;

            const viewport = await options.getViewport();
            if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;
            if (!viewportMatchesPreparation(viewport, preparation)) {
                await requestFreshPreparation(isAttemptCurrent);
                return;
            }

            await options.settle(!latestShownPreparation);
            if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;

            const settledViewport = await options.getViewport();
            if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;
            if (!viewportMatchesPreparation(settledViewport, preparation)) {
                await requestFreshPreparation(isAttemptCurrent);
                return;
            }

            const outcome = await options.flush(preparation);
            if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;
            if (outcome === 'committed') {
                resolvePendingCommit(true);
                return;
            }
            // The host already replaced this preparation, so retrying this token
            // cannot succeed. Its replacement may be published just after the
            // acknowledgement: if it lands, this attempt simply ends and the new
            // one takes over.
            if (outcome === 'superseded') {
                await waitForSupersedingPreparation();
                if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;
                resolvePendingCommit(false);
                return;
            }
            if (commitRetries >= 2) {
                resolvePendingCommit(false);
                options.onError?.(
                    new Error('Search surface preparation was repeatedly superseded')
                );
                return;
            }
            commitRetries += 1;
            attemptPreparation();
        })().catch((error) => {
            if (isCurrent(preparation, capturedIntent, capturedAttempt)) {
                resolvePendingCommit(false);
                options.onError?.(error);
            }
        });
    }

    function receivePreparation(preparation: SearchSurfacePreparation): Promise<boolean> {
        if (disposed) return Promise.resolve(false);
        if (
            latestShownPreparation &&
            comparePreparation(preparation, latestShownPreparation) <= 0
        ) {
            return Promise.resolve(true);
        }
        if (pendingPreparation && comparePreparation(preparation, pendingPreparation) <= 0) {
            return comparePreparation(preparation, pendingPreparation) === 0 && pendingCommit
                ? pendingCommit.promise
                : Promise.resolve(false);
        }

        resolvePendingCommit(false);
        intentEpoch += 1;
        commitRetries = 0;
        refreshRequests = 0;
        pendingPreparation = preparation;
        let resolveCommit!: (committed: boolean) => void;
        const commitPromise = new Promise<boolean>((resolve) => {
            resolveCommit = resolve;
        });
        pendingCommit = {
            promise: commitPromise,
            resolve: resolveCommit,
            settled: false,
        };
        attemptPreparation();
        return commitPromise;
    }

    async function installSubscriptions(owner: SubscriptionOwner) {
        try {
            await Promise.all([
                listenForOwner<SearchSurfacePreparation>(
                    owner,
                    (handler) => options.listenPrepare(handler),
                    (payload) => {
                        void receivePreparation(payload);
                    }
                ),
                listenForOwner<SearchSurfaceShownEvent>(
                    owner,
                    (handler) => options.listenShown(handler),
                    async (payload) => {
                        if (
                            pendingPreparation &&
                            shownMatchesPreparation(payload, pendingPreparation)
                        ) {
                            confirmPreparationShown(payload);
                        }
                        await options.onShown(payload);
                    }
                ),
                listenForOwner<SearchSurfaceHiddenEvent>(
                    owner,
                    (handler) => options.listenHidden(handler),
                    async (payload) => {
                        cancellationEpoch += 1;
                        latestShownPreparation = null;
                        invalidatePreparation();
                        await options.onHidden(payload);
                    }
                ),
            ]);
            if (ownsSubscriptions(owner)) owner.lifecycle.dispatch('activate');
        } catch (error) {
            owner.lifecycle.dispatch('fail');
            if (subscriptionOwner === owner) {
                subscriptionOwner = undefined;
                invalidatePreparation();
            }
            releaseSubscriptions(owner);
            throw error;
        }
    }

    function ensureSubscriptions() {
        if (subscriptionOwner) return subscriptionOwner.ready;
        const owner = createSubscriptionOwner();
        subscriptionOwner = owner;
        void installSubscriptions(owner).then(owner.resolveReady, owner.rejectReady);
        return owner.ready;
    }

    async function start(): Promise<boolean> {
        if (disposed) return false;
        await ensureSubscriptions();
        if (disposed) return false;

        const rendererEpoch = await options.getRendererEpoch();
        if (disposed) return false;
        const capturedCancellationEpoch = cancellationEpoch;
        const preparation = await options.markRendererReady(rendererEpoch);
        if (disposed || capturedCancellationEpoch !== cancellationEpoch || !preparation) {
            return false;
        }
        let expectedPreparation = preparation;
        while (!disposed) {
            const committed = await receivePreparation(expectedPreparation);
            if (committed) return true;
            if (disposed) return false;
            const latestPreparation = pendingPreparation;
            if (!latestPreparation) return false;
            const ordering = comparePreparation(latestPreparation, expectedPreparation);
            if (ordering > 0) {
                expectedPreparation = latestPreparation;
                continue;
            }
            return false;
        }
        return false;
    }

    function notifyViewportChanged() {
        attemptPreparation();
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        cancellationEpoch += 1;
        latestShownPreparation = null;
        invalidatePreparation();
        const owner = subscriptionOwner;
        subscriptionOwner = undefined;
        if (owner) {
            owner.lifecycle.dispatch('dispose');
            releaseSubscriptions(owner);
        }
    }

    return { start, notifyViewportChanged, dispose };
}

const MAC_PAINT_SETTLE_TIMEOUT_MS = 48;

async function waitForMacPaint(): Promise<void> {
    if (typeof requestAnimationFrame !== 'function') return;
    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        // The parked macOS window keeps rAF running. Waiting for the second
        // frame puts the prepared layout in the compositor before the native
        // window turns opaque, so the reveal cannot flash the previous frame.
        const timer = setTimeout(finish, MAC_PAINT_SETTLE_TIMEOUT_MS);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                clearTimeout(timer);
                finish();
            })
        );
    });
}

export async function settleSearchSurfaceViewport(waitForPaint = true): Promise<void> {
    // Geometry reads flush layout after Vue commits. Native occlusion can throttle
    // frames and timers even while WebView2 reports document.visibilityState as visible.
    await nextTick();
    if (waitForPaint && isMacPlatform()) await waitForMacPaint();
}

function viewportMatchesPreparation(
    viewport: SearchSurfaceViewportSnapshot,
    preparation: SearchSurfacePreparation
) {
    const expected = preparation.physicalViewport;
    const actual = viewport.physicalViewport;
    // Regions use client coordinates. Native recentering changes only the screen
    // origin and must not strand a preparation with an otherwise matching viewport.
    return (
        actual.width === expected.width &&
        actual.height === expected.height &&
        Math.abs(viewport.scaleFactor - preparation.scaleFactor) < 0.000_001
    );
}

function comparePreparation(
    left: SearchSurfacePreparationIdentity,
    right: SearchSurfacePreparationIdentity
): number {
    const rendererDifference = left.rendererEpoch - right.rendererEpoch;
    if (rendererDifference !== 0) return rendererDifference;
    const showDifference = left.showEpoch - right.showEpoch;
    if (showDifference !== 0) return showDifference;
    return left.hostEpoch - right.hostEpoch;
}

function shownMatchesPreparation(
    shown: SearchSurfaceShownEvent,
    preparation: SearchSurfacePreparation
) {
    return (
        shown.rendererEpoch === preparation.rendererEpoch &&
        shown.showEpoch === preparation.showEpoch &&
        shown.hostEpoch === preparation.hostEpoch
    );
}
