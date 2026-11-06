import type {
    SearchSurfaceHiddenEvent,
    SearchSurfaceShownEvent,
} from '@services/EventService/types';
import type {
    SearchSurfacePhysicalViewport,
    SearchSurfacePreparation,
} from '@services/NativeService/types';
import { nextTick } from 'vue';

type Unlisten = () => void;
type SearchSurfacePreparationIdentity = Pick<
    SearchSurfacePreparation,
    'rendererEpoch' | 'showEpoch' | 'hostEpoch'
>;

export interface SearchSurfaceViewportSnapshot {
    physicalViewport: SearchSurfacePhysicalViewport;
    scaleFactor: number;
}

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
    settle: () => Promise<void>;
    flush: (preparation: SearchSurfacePreparation) => Promise<boolean>;
    onShown: (payload: SearchSurfaceShownEvent) => void | Promise<void>;
    onHidden: (payload: SearchSurfaceHiddenEvent) => void | Promise<void>;
    onError?: (error: unknown) => void;
}

export interface SearchSurfacePreparationController {
    start: () => Promise<boolean>;
    notifyViewportChanged: () => void;
    dispose: () => void;
}

export function createSearchSurfacePreparationController(
    options: SearchSurfacePreparationControllerOptions
): SearchSurfacePreparationController {
    let disposed = false;
    let cancellationEpoch = 0;
    let intentEpoch = 0;
    let attemptEpoch = 0;
    let commitRetries = 0;
    let pendingPreparation: SearchSurfacePreparation | null = null;
    let latestShownPreparation: SearchSurfacePreparationIdentity | null = null;
    let pendingCommit: {
        promise: Promise<boolean>;
        resolve: (committed: boolean) => void;
        settled: boolean;
    } | null = null;
    const unlisteners: Unlisten[] = [];

    function registerUnlisten(unlisten: Unlisten) {
        if (disposed) {
            unlisten();
            return;
        }
        unlisteners.push(unlisten);
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

    function attemptPreparation() {
        const preparation = pendingPreparation;
        if (!preparation || disposed) return;

        const capturedIntent = intentEpoch;
        const capturedAttempt = ++attemptEpoch;
        void (async () => {
            const viewport = await options.getViewport();
            if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;
            if (!viewportMatchesPreparation(viewport, preparation)) return;

            await options.settle();
            if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;

            const settledViewport = await options.getViewport();
            if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;
            if (!viewportMatchesPreparation(settledViewport, preparation)) return;

            const committed = await options.flush(preparation);
            if (!isCurrent(preparation, capturedIntent, capturedAttempt)) return;
            if (committed) {
                resolvePendingCommit(true);
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

    async function start(): Promise<boolean> {
        const installs = [
            options
                .listenPrepare((payload) => {
                    void receivePreparation(payload);
                })
                .then(registerUnlisten),
            options
                .listenShown(async (payload) => {
                    if (disposed) return;
                    if (
                        pendingPreparation &&
                        shownMatchesPreparation(payload, pendingPreparation)
                    ) {
                        confirmPreparationShown(payload);
                    }
                    await options.onShown(payload);
                })
                .then(registerUnlisten),
            options
                .listenHidden(async (payload) => {
                    if (disposed) return;
                    cancellationEpoch += 1;
                    latestShownPreparation = null;
                    invalidatePreparation();
                    await options.onHidden(payload);
                })
                .then(registerUnlisten),
        ];
        await Promise.all(installs);
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
        for (const unlisten of unlisteners.splice(0)) unlisten();
    }

    return { start, notifyViewportChanged, dispose };
}

export async function settleSearchSurfaceViewport(): Promise<void> {
    // Geometry reads flush layout after Vue commits. Native occlusion can throttle
    // frames and timers even while WebView2 reports document.visibilityState as visible.
    await nextTick();
}

function viewportMatchesPreparation(
    viewport: SearchSurfaceViewportSnapshot,
    preparation: SearchSurfacePreparation
) {
    const expected = preparation.physicalViewport;
    const actual = viewport.physicalViewport;
    return (
        actual.x === expected.x &&
        actual.y === expected.y &&
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
