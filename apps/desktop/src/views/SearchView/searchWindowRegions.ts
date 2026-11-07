import type {
    SearchSurfacePreparation,
    SearchWindowRegion,
    SearchWindowRegionUpdate,
} from '@services/NativeService/types';

const SEARCH_SURFACE_CORNER_RADIUS = 8;
const OVERLAY_CORNER_RADIUS = 8;
// Keep the native region just beyond the browser shadow. A larger envelope
// exposes unpainted transparent WebView pixels on Windows, which renders as a
// coloured strip instead of the desktop beneath the window.
export const SEARCH_WINDOW_REGION_OUTSET = 24;
// Logical panel sizing keeps its existing safety budget independently from
// the native hit-test/paint envelope above.
export const SEARCH_WINDOW_VISUAL_OUTSET = 48;
const SEARCH_WINDOW_REGION_GENERATION_KEY = 'touchai.search-window-region-generation';
let nextSearchWindowRegionGeneration = 0;

function readPersistedSearchWindowRegionGeneration(): number {
    try {
        const generation = Number(
            window.sessionStorage.getItem(SEARCH_WINDOW_REGION_GENERATION_KEY)
        );
        return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
    } catch {
        return 0;
    }
}
function persistSearchWindowRegionGeneration(generation: number) {
    try {
        window.sessionStorage.setItem(SEARCH_WINDOW_REGION_GENERATION_KEY, String(generation));
    } catch {
        // A module-local counter still preserves ordering when browser storage is unavailable.
    }
}

function observeSearchWindowRegionGeneration(generation: number) {
    if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error('Native search window region generation is invalid');
    }

    nextSearchWindowRegionGeneration = Math.max(nextSearchWindowRegionGeneration, generation);
    persistSearchWindowRegionGeneration(nextSearchWindowRegionGeneration);
}

function allocateSearchWindowRegionGeneration(): number {
    nextSearchWindowRegionGeneration = Math.max(
        nextSearchWindowRegionGeneration,
        readPersistedSearchWindowRegionGeneration()
    );
    if (nextSearchWindowRegionGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Search window region generation exhausted');
    }

    nextSearchWindowRegionGeneration += 1;
    persistSearchWindowRegionGeneration(nextSearchWindowRegionGeneration);
    return nextSearchWindowRegionGeneration;
}

function toRegion(
    rect: DOMRect,
    cornerRadius: number,
    visualOutset: number
): SearchWindowRegion | null {
    if (
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height) ||
        rect.width <= 0 ||
        rect.height <= 0
    ) {
        return null;
    }

    const x = rect.left - visualOutset;
    const y = rect.top - visualOutset;
    const width = rect.width + visualOutset * 2;
    const height = rect.height + visualOutset * 2;
    const expandedCornerRadius = cornerRadius + visualOutset;
    if (![x, y, width, height, expandedCornerRadius].every(Number.isFinite)) {
        return null;
    }

    return { x, y, width, height, cornerRadius: expandedCornerRadius };
}

export function resolveSearchWindowRegions(
    surfaceRect: DOMRect,
    overlayRect: DOMRect | null
): SearchWindowRegion[] {
    // The search host uses a native window region on Windows. Keep a
    // transparent envelope around each visual surface so the browser can
    // paint its drop shadow outside the solid border instead of having the
    // native region clip it away.
    const surface = toRegion(
        surfaceRect,
        SEARCH_SURFACE_CORNER_RADIUS,
        SEARCH_WINDOW_REGION_OUTSET
    );
    if (!surface) {
        return [];
    }

    const overlay = overlayRect
        ? toRegion(overlayRect, OVERLAY_CORNER_RADIUS, SEARCH_WINDOW_REGION_OUTSET)
        : null;
    return overlay ? [surface, overlay] : [surface];
}

export function resolveSearchWindowDragRegion(width: number, height: number): SearchWindowRegion[] {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return [];
    }

    return [{ x: 0, y: 0, width, height, cornerRadius: 0 }];
}

export interface SearchWindowRegionGeometry {
    regions: SearchWindowRegion[];
}

export function resolveSearchWindowRegionGeometry(
    surfaceRect: DOMRect,
    overlayRect: DOMRect | null,
    interactionHost: { width: number; height: number } | null
): SearchWindowRegionGeometry {
    if (interactionHost) {
        return {
            regions: resolveSearchWindowDragRegion(interactionHost.width, interactionHost.height),
        };
    }

    return {
        regions: resolveSearchWindowRegions(surfaceRect, overlayRect),
    };
}

export function createSearchWindowRegionSignature(regions: SearchWindowRegion[]): string {
    return JSON.stringify(regions);
}

export function validateSearchSurfacePreparationUpdate(
    update: SearchWindowRegionUpdate,
    preparation: SearchSurfacePreparation | undefined,
    generation: number
): SearchWindowRegionUpdate {
    if (!preparation || update.status !== 'applied') return update;

    const shown = update.showStatus;
    if (
        !shown ||
        shown.status !== 'shown' ||
        shown.rendererEpoch !== preparation.rendererEpoch ||
        shown.showEpoch !== preparation.showEpoch ||
        shown.hostEpoch !== preparation.hostEpoch ||
        shown.generation !== generation
    ) {
        throw new Error('Search surface preparation acknowledgement is invalid');
    }
    return update;
}

export interface SearchWindowRegionReport<TContext = unknown> {
    signature: string;
    context?: TContext;
    report: (
        generation: number,
        context: TContext | undefined
    ) => Promise<SearchWindowRegionUpdate> | SearchWindowRegionUpdate;
}

export interface SearchWindowRegionReporter<TContext = unknown> {
    schedule: (reason: string, force?: boolean, immediate?: boolean) => void;
    flush: (reason: string, force?: boolean, context?: TContext) => Promise<boolean>;
    dispose: () => void;
}

export function createSearchWindowRegionReporter<TContext = unknown>(
    resolveReport: (context?: TContext) => SearchWindowRegionReport<TContext> | null,
    settleDelay = 100,
    onReportFailure?: (error: unknown) => void
): SearchWindowRegionReporter<TContext> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastReport: { signature: string; generation: number } | null = null;
    let forceNextReport = false;
    let disposed = false;
    // Native region writes are serialized, but a newer request supersedes the
    // acknowledgement policy of any older request that is still in flight.
    // The request id lets stale/error responses from the older call finish
    // without rebasing or clearing the latest report.
    let dispatchInFlight: Promise<unknown> | null = null;
    let nativeReportInFlight = false;
    let latestRequestId = 0;
    let pendingDispatch: {
        requestId: number;
        promise: Promise<boolean>;
        resolve: (value: boolean) => void;
        reject: (reason: unknown) => void;
        context: TContext | undefined;
    } | null = null;
    const STALE_REBASE_RETRY_LIMIT = 1;

    async function dispatchReport(
        requestId: number,
        dispatchContext: TContext | undefined
    ): Promise<boolean> {
        if (disposed || requestId !== latestRequestId) return false;

        const nextReport = resolveReport(dispatchContext);
        const shouldForce = forceNextReport;
        forceNextReport = false;
        if (!nextReport || (!shouldForce && nextReport.signature === lastReport?.signature)) {
            return false;
        }

        let generation = allocateSearchWindowRegionGeneration();
        const context = dispatchContext ?? nextReport.context;
        lastReport = { signature: nextReport.signature, generation };
        try {
            let staleRetriesRemaining = STALE_REBASE_RETRY_LIMIT;
            while (true) {
                const reportResult = nextReport.report(generation, context);
                const update =
                    reportResult &&
                    typeof reportResult === 'object' &&
                    'then' in reportResult &&
                    typeof reportResult.then === 'function'
                        ? await (async () => {
                              nativeReportInFlight = true;
                              try {
                                  return await reportResult;
                              } finally {
                                  nativeReportInFlight = false;
                              }
                          })()
                        : (reportResult as SearchWindowRegionUpdate);
                if (disposed) return false;

                // A newer request was queued while this native call was in
                // flight.  Its write is still allowed to complete, but this
                // acknowledgement must not affect the newer report.
                const isLatestRequest = requestId === latestRequestId;
                if (update.status === 'applied') {
                    if (update.generation !== generation) {
                        throw new Error(
                            'Search window region acknowledgement generation mismatched'
                        );
                    }
                    return lastReport?.generation === generation;
                }

                if (update.status !== 'stale') {
                    throw new Error('Search window region acknowledgement is invalid');
                }

                if (
                    update.requestedGeneration !== generation ||
                    !Number.isSafeInteger(update.activeGeneration) ||
                    update.activeGeneration < generation
                ) {
                    throw new Error('Search window region stale acknowledgement is invalid');
                }
                observeSearchWindowRegionGeneration(update.activeGeneration);

                if (!isLatestRequest) return false;
                if (staleRetriesRemaining <= 0) {
                    throw new Error('Search window region remained stale after rebasing');
                }

                staleRetriesRemaining -= 1;
                generation = allocateSearchWindowRegionGeneration();
                lastReport = { signature: nextReport.signature, generation };
            }
        } catch (error) {
            const isLatestRequest = requestId === latestRequestId;
            if (isLatestRequest && lastReport?.generation === generation) {
                lastReport = null;
            }
            if (!isLatestRequest) return false;
            throw error;
        }
    }

    function enqueueDispatch(context: TContext | undefined): Promise<boolean> {
        if (dispatchInFlight) {
            // There is at most one pending dispatch.  Coalescing subsequent
            // signals here keeps a forced report from being superseded by an
            // unchanged layout signal before it reaches the IPC boundary.
            if (pendingDispatch) {
                if (context !== undefined) pendingDispatch.context = context;
                return pendingDispatch.promise;
            }

            const requestId = ++latestRequestId;
            let resolvePending!: (value: boolean) => void;
            let rejectPending!: (reason: unknown) => void;
            const promise = new Promise<boolean>((resolve, reject) => {
                resolvePending = resolve;
                rejectPending = reject;
            });
            const pending = {
                requestId,
                promise,
                resolve: resolvePending,
                reject: rejectPending,
                context,
            };
            pendingDispatch = pending;

            const queuedDispatch = dispatchInFlight.then(
                () => {
                    if (pendingDispatch === pending) pendingDispatch = null;
                    return dispatchReport(requestId, pending.context);
                },
                () => {
                    if (pendingDispatch === pending) pendingDispatch = null;
                    return dispatchReport(requestId, pending.context);
                }
            );
            queuedDispatch.then(pending.resolve, pending.reject);

            dispatchInFlight = queuedDispatch;
            void queuedDispatch.then(
                () => {
                    if (dispatchInFlight === queuedDispatch) dispatchInFlight = null;
                },
                () => {
                    if (dispatchInFlight === queuedDispatch) dispatchInFlight = null;
                }
            );
            return promise;
        }

        const requestId = ++latestRequestId;
        const queuedDispatch = dispatchReport(requestId, context);
        if (nativeReportInFlight) {
            dispatchInFlight = queuedDispatch;
            void queuedDispatch.then(
                () => {
                    if (dispatchInFlight === queuedDispatch) dispatchInFlight = null;
                },
                () => {
                    if (dispatchInFlight === queuedDispatch) dispatchInFlight = null;
                }
            );
        }
        return queuedDispatch;
    }
    function dispatchScheduledReport() {
        void enqueueDispatch(undefined).catch((error) => {
            if (disposed) return;
            onReportFailure?.(error);
        });
    }

    function schedule(_reason: string, force = false, immediate = false) {
        if (disposed) return;

        forceNextReport ||= force;
        if (timeoutId !== null) clearTimeout(timeoutId);
        timeoutId = null;

        if (immediate) {
            dispatchScheduledReport();
            return;
        }

        timeoutId = setTimeout(() => {
            timeoutId = null;
            dispatchScheduledReport();
        }, settleDelay);
    }

    async function flush(_reason: string, force = false, context?: TContext): Promise<boolean> {
        if (disposed) return false;

        forceNextReport ||= force;
        if (timeoutId !== null) clearTimeout(timeoutId);
        timeoutId = null;
        return enqueueDispatch(context);
    }

    function dispose() {
        disposed = true;
        forceNextReport = false;
        if (timeoutId !== null) clearTimeout(timeoutId);
        timeoutId = null;
    }

    return { schedule, flush, dispose };
}
