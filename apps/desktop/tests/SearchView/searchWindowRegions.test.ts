import type {
    SearchSurfacePreparation,
    SearchWindowRegionUpdate,
} from '@services/NativeService/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SearchWindowRegionReport } from '@/views/SearchView/searchWindowRegions';
import {
    createSearchWindowRegionReporter,
    createSearchWindowRegionSignature,
    resolveSearchWindowDragRegion,
    resolveSearchWindowRegions,
    validateSearchSurfacePreparationUpdate,
} from '@/views/SearchView/searchWindowRegions';

function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

function appliedUpdate(generation: number): SearchWindowRegionUpdate {
    return { status: 'applied', generation };
}

function successfulReport() {
    return vi.fn((generation: number) => appliedUpdate(generation));
}

function surfacePreparation(): SearchSurfacePreparation {
    return {
        rendererEpoch: 3,
        showEpoch: 5,
        hostEpoch: 8,
        source: 'shortcut',
        physicalViewport: { x: -1920, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1.25,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('resolveSearchWindowRegions', () => {
    it('keeps a visual envelope around the search surface for its CSS shadow', () => {
        expect(resolveSearchWindowRegions(rect(0, 0, 750, 420), null)).toEqual([
            { x: -24, y: -24, width: 798, height: 468, cornerRadius: 32 },
        ]);
    });

    it('keeps separate visual envelopes for panel and overlay shadows', () => {
        expect(
            resolveSearchWindowRegions(rect(0, 0, 750, 420), rect(430.25, 65.5, 300.5, 360.25))
        ).toEqual([
            { x: -24, y: -24, width: 798, height: 468, cornerRadius: 32 },
            { x: 406.25, y: 41.5, width: 348.5, height: 408.25, cornerRadius: 32 },
        ]);
    });

    it('uses one full-host interaction envelope while the logical panel is dragging', () => {
        expect(resolveSearchWindowDragRegion(1920, 1040)).toEqual([
            { x: 0, y: 0, width: 1920, height: 1040, cornerRadius: 0 },
        ]);
        expect(resolveSearchWindowDragRegion(0, 1040)).toEqual([]);
    });

    it('drops empty geometry and provides a stable signature for duplicate suppression', () => {
        const regions = resolveSearchWindowRegions(rect(0, 0, 750, 60), rect(20, 20, 0, 100));

        expect(regions).toHaveLength(1);
        expect(createSearchWindowRegionSignature(regions)).toBe(
            createSearchWindowRegionSignature([{ ...regions[0]! }])
        );
    });
});

describe('createSearchWindowRegionReporter', () => {
    it('waits for a forced region flush to finish before resolving', async () => {
        const pendingReport = deferred<SearchWindowRegionUpdate>();
        let reportedGeneration = 0;
        const report = vi.fn((generation: number) => {
            reportedGeneration = generation;
            return pendingReport.promise;
        });
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'ready-region', report }),
            100
        );

        let flushFinished = false;
        const flush = reporter.flush('renderer-ready', true).then((reported) => {
            flushFinished = true;
            return reported;
        });

        expect(report).toHaveBeenCalledTimes(1);
        expect(flushFinished).toBe(false);

        pendingReport.resolve(appliedUpdate(reportedGeneration));
        await expect(flush).resolves.toBe(true);
        expect(flushFinished).toBe(true);
    });

    it('coalesces repeated geometry signals until the layout settles', () => {
        vi.useFakeTimers();
        const report = successfulReport();
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'current-payload', report }),
            100
        );

        reporter.schedule('geometry');
        vi.advanceTimersByTime(50);
        reporter.schedule('geometry');
        vi.advanceTimersByTime(99);
        expect(report).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(report).toHaveBeenCalledTimes(1);
    });

    it('suppresses an unchanged settled payload but re-reports it when forced', () => {
        vi.useFakeTimers();
        const report = successfulReport();
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'current-payload', report }),
            100
        );

        reporter.schedule('geometry');
        vi.advanceTimersByTime(100);
        reporter.schedule('geometry');
        vi.advanceTimersByTime(100);
        reporter.schedule('search-surface-shown', true);
        vi.advanceTimersByTime(100);

        expect(report).toHaveBeenCalledTimes(2);
    });

    it('settles a semantic panel-layout signal before reporting the new region', () => {
        vi.useFakeTimers();
        let signature = 'height:180';
        const report = successfulReport();
        const reporter = createSearchWindowRegionReporter(() => ({ signature, report }), 100);

        reporter.schedule('logical-panel-height');
        signature = 'height:220';
        reporter.schedule('logical-panel-height');
        vi.advanceTimersByTime(99);
        expect(report).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(report).toHaveBeenCalledTimes(1);
    });

    it('reports an overlay transition envelope immediately without delaying panel geometry', () => {
        vi.useFakeTimers();
        let signature = 'panel-only';
        const report = successfulReport();
        const reporter = createSearchWindowRegionReporter(() => ({ signature, report }), 100);

        reporter.schedule('logical-panel-height');
        signature = 'panel-and-overlay';
        reporter.schedule('overlay-transition-envelope', false, true);

        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalledWith(expect.any(Number), undefined);
        vi.advanceTimersByTime(100);
        expect(report).toHaveBeenCalledTimes(1);
    });

    it('assigns a monotonically increasing generation to each dispatched report', () => {
        vi.useFakeTimers();
        let signature = 'height:180';
        const report = successfulReport();
        const reporter = createSearchWindowRegionReporter(() => ({ signature, report }), 100);

        reporter.schedule('initial');
        vi.advanceTimersByTime(100);
        signature = 'height:220';
        reporter.schedule('layout');
        vi.advanceTimersByTime(100);

        const generations = report.mock.calls.map(([generation]) => generation);
        expect(generations[1]).toBe(generations[0]! + 1);
    });

    it('keeps generations increasing across reporter instances', () => {
        const firstReport = successfulReport();
        const secondReport = successfulReport();
        const firstReporter = createSearchWindowRegionReporter(
            () => ({ signature: 'first', report: firstReport }),
            100
        );
        const secondReporter = createSearchWindowRegionReporter(
            () => ({ signature: 'second', report: secondReport }),
            100
        );

        firstReporter.schedule('first-mount', false, true);
        firstReporter.dispose();
        secondReporter.schedule('second-mount', false, true);

        expect(secondReport.mock.calls[0]?.[0]).toBeGreaterThan(firstReport.mock.calls[0]![0]);
    });

    it('does not invalidate the latest report when an older forced report rejects', async () => {
        vi.useFakeTimers();
        let rejectFirstReport!: (error: Error) => void;
        const firstReport = new Promise<SearchWindowRegionUpdate>((_resolve, reject) => {
            rejectFirstReport = reject;
        });
        const report = vi
            .fn()
            .mockImplementationOnce(() => firstReport)
            .mockImplementationOnce((generation: number) => appliedUpdate(generation));
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'same-geometry', report }),
            100
        );

        reporter.schedule('initial');
        vi.advanceTimersByTime(100);
        reporter.schedule('visibility', true);
        vi.advanceTimersByTime(100);
        rejectFirstReport(new Error('older IPC failed'));
        await Promise.resolve();
        await Promise.resolve();

        reporter.schedule('unchanged');
        await vi.advanceTimersByTimeAsync(100);

        expect(report).toHaveBeenCalledTimes(2);
    });

    it('cancels pending work when disposed', () => {
        vi.useFakeTimers();
        const report = successfulReport();
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'current-payload', report }),
            100
        );

        reporter.schedule('geometry');
        reporter.dispose();
        vi.advanceTimersByTime(100);

        expect(report).not.toHaveBeenCalled();
    });

    it('does not rebase a stale acknowledgement that settles after disposal', async () => {
        const pendingReport = deferred<SearchWindowRegionUpdate>();
        const report = vi
            .fn()
            .mockImplementationOnce(() => pendingReport.promise)
            .mockImplementation((generation: number) => appliedUpdate(generation));
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'current-payload', report }),
            100
        );

        const flush = reporter.flush('renderer-ready', true);
        const requestedGeneration = report.mock.calls[0]![0];
        reporter.dispose();
        pendingReport.resolve({
            status: 'stale',
            requestedGeneration,
            activeGeneration: requestedGeneration + 100,
        });

        const flushed = await flush;
        const nextReport = successfulReport();
        const nextReporter = createSearchWindowRegionReporter(
            () => ({ signature: 'next-payload', report: nextReport }),
            100
        );
        await expect(nextReporter.flush('next-report', true)).resolves.toBe(true);

        expect(nextReport.mock.calls[0]![0]).toBe(requestedGeneration + 1);
        expect(flushed).toBe(false);
        expect(report).toHaveBeenCalledTimes(1);
        nextReporter.dispose();
    });

    it('retries a settled region report after a transient native failure', async () => {
        vi.useFakeTimers();
        const report = vi
            .fn()
            .mockRejectedValueOnce(new Error('transient region failure'))
            .mockImplementationOnce((generation: number) => appliedUpdate(generation));
        const onReportFailure = vi.fn();
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'settled-panel', report }),
            50,
            onReportFailure
        );

        reporter.schedule('geometry');
        await vi.advanceTimersByTimeAsync(50);

        expect(report).toHaveBeenCalledTimes(1);
        expect(onReportFailure).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(50);

        expect(report).toHaveBeenCalledTimes(2);
        expect(onReportFailure).not.toHaveBeenCalled();
        reporter.dispose();
    });

    it('reports an exhausted settled region failure after bounded retries', async () => {
        vi.useFakeTimers();
        const error = new Error('persistent settled region failure');
        const report = vi.fn().mockRejectedValue(error);
        const onReportFailure = vi.fn();
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'settled-panel', report }),
            50,
            onReportFailure
        );

        reporter.schedule('geometry');
        await vi.advanceTimersByTimeAsync(150);

        expect(report).toHaveBeenCalledTimes(3);
        expect(onReportFailure).toHaveBeenCalledOnce();
        expect(onReportFailure).toHaveBeenCalledWith(error);
        reporter.dispose();
    });

    it('retries an immediate final region report after a transient native failure', async () => {
        vi.useFakeTimers();
        let signature = 'full-host';
        const report = vi
            .fn()
            .mockImplementationOnce((generation: number) => appliedUpdate(generation))
            .mockRejectedValueOnce(new Error('transient region failure'))
            .mockImplementationOnce((generation: number) => appliedUpdate(generation));
        const reporter = createSearchWindowRegionReporter(() => ({ signature, report }), 50);

        reporter.schedule('interaction-start', true, true);
        await Promise.resolve();
        signature = 'tight-panel';
        reporter.schedule('interaction-end', true, true);
        await Promise.resolve();
        await Promise.resolve();

        expect(report).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(50);

        expect(report).toHaveBeenCalledTimes(3);
        reporter.dispose();
    });

    it('reports an exhausted immediate region failure after bounded retries', async () => {
        vi.useFakeTimers();
        const error = new Error('persistent region failure');
        const report = vi.fn().mockRejectedValue(error);
        const onImmediateFailure = vi.fn();
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'full-host', report }),
            50,
            onImmediateFailure
        );

        reporter.schedule('interaction-start', true, true);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);

        expect(report).toHaveBeenCalledTimes(3);
        expect(onImmediateFailure).toHaveBeenCalledWith(error);
        reporter.dispose();
    });

    it('keeps generations increasing when the renderer module reloads', async () => {
        sessionStorage.clear();
        vi.resetModules();
        const firstModule = await import('@/views/SearchView/searchWindowRegions');
        const firstReport = successfulReport();
        const firstReporter = firstModule.createSearchWindowRegionReporter(
            () => ({ signature: 'first-renderer', report: firstReport }),
            100
        );

        firstReporter.schedule('first-renderer', false, true);
        firstReporter.dispose();

        vi.resetModules();
        const reloadedModule = await import('@/views/SearchView/searchWindowRegions');
        const reloadedReport = vi.fn((generation: number) => appliedUpdate(generation));
        const reloadedReporter = reloadedModule.createSearchWindowRegionReporter(
            () => ({ signature: 'reloaded-renderer', report: reloadedReport }),
            100
        );

        reloadedReporter.schedule('reloaded-renderer', false, true);
        reloadedReporter.dispose();

        expect(reloadedReport.mock.calls[0]?.[0]).toBeGreaterThan(firstReport.mock.calls[0]![0]);
    });

    it('rejects an unknown acknowledgement status without treating it as stale', async () => {
        const report = vi
            .fn((generation: number) => Promise.resolve(appliedUpdate(generation)))
            .mockImplementationOnce((generation: number) =>
                Promise.resolve({
                    status: 'unknown',
                    requestedGeneration: generation,
                    activeGeneration: generation + 100,
                } as unknown as SearchWindowRegionUpdate)
            );
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'current-payload', report }),
            100
        );

        let firstError: unknown;
        try {
            await reporter.flush('renderer-ready', true);
        } catch (error) {
            firstError = error;
        }
        await expect(reporter.flush('next-report', true)).resolves.toBe(true);

        const requestedGeneration = report.mock.calls[0]![0];
        expect(report.mock.calls[1]![0]).toBe(requestedGeneration + 1);
        expect(firstError).toEqual(
            expect.objectContaining({
                message: 'Search window region acknowledgement is invalid',
            })
        );
        expect(report).toHaveBeenCalledTimes(2);
        reporter.dispose();
    });

    it('rebases from a stale native generation and immediately reapplies the current geometry', async () => {
        vi.resetModules();
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('session storage unavailable');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('session storage unavailable');
        });
        const reloadedModule = await import('@/views/SearchView/searchWindowRegions');
        const report = vi
            .fn()
            .mockResolvedValueOnce({
                status: 'stale',
                requestedGeneration: 1,
                activeGeneration: 100,
            })
            .mockResolvedValueOnce({ status: 'applied', generation: 101 });
        const reporter = reloadedModule.createSearchWindowRegionReporter(
            () => ({ signature: 'reloaded-geometry', report }),
            100
        );

        await expect(reporter.flush('renderer-ready', true)).resolves.toBe(true);
        expect(report.mock.calls.map(([generation]) => generation)).toEqual([1, 101]);
        reporter.dispose();
    });

    it('lets an older stale response raise the generation floor without disturbing the latest report', async () => {
        vi.useFakeTimers();
        sessionStorage.clear();
        vi.resetModules();
        const reloadedModule = await import('@/views/SearchView/searchWindowRegions');
        let resolveOldReport!: (update: {
            status: 'stale';
            requestedGeneration: number;
            activeGeneration: number;
        }) => void;
        const oldReport = new Promise<{
            status: 'stale';
            requestedGeneration: number;
            activeGeneration: number;
        }>((resolve) => {
            resolveOldReport = resolve;
        });
        let signature = 'old-geometry';
        const report = vi
            .fn()
            .mockImplementationOnce(() => oldReport)
            .mockImplementation((generation: number) => Promise.resolve(appliedUpdate(generation)));
        const reporter = reloadedModule.createSearchWindowRegionReporter(
            () => ({ signature, report }),
            100
        );

        reporter.schedule('old', false, true);
        signature = 'latest-geometry';
        reporter.schedule('latest', true, true);
        await Promise.resolve();
        await Promise.resolve();
        resolveOldReport({ status: 'stale', requestedGeneration: 1, activeGeneration: 100 });
        await Promise.resolve();
        await Promise.resolve();

        reporter.schedule('unchanged-latest', false, true);
        await Promise.resolve();
        expect(report).toHaveBeenCalledTimes(2);

        signature = 'next-geometry';
        reporter.schedule('next', false, true);
        await vi.runAllTimersAsync();
        expect(report).toHaveBeenCalledTimes(3);
        expect(report.mock.calls[1]?.[0]).toBeGreaterThan(100);
        expect(report.mock.calls[2]?.[0]).toBeGreaterThan(report.mock.calls[1]?.[0] ?? 0);
        reporter.dispose();
    });

    it('serializes an older in-flight write before dispatching newer geometry', async () => {
        const oldAcknowledgement = deferred<SearchWindowRegionUpdate>();
        let signature = 'old-geometry';
        const report = vi.fn((generation: number) =>
            signature === 'old-geometry'
                ? oldAcknowledgement.promise
                : Promise.resolve(appliedUpdate(generation))
        );
        const reporter = createSearchWindowRegionReporter(() => ({ signature, report }), 100);

        const oldFlush = reporter.flush('old', true);
        const oldGeneration = report.mock.calls[0]![0];
        signature = 'final-geometry';
        const finalFlush = reporter.flush('final', true);

        // The newer geometry must not enter the IPC boundary while the older
        // write is still unresolved.
        expect(report).toHaveBeenCalledTimes(1);

        oldAcknowledgement.resolve(appliedUpdate(oldGeneration));

        await expect(oldFlush).resolves.toBe(true);
        await expect(finalFlush).resolves.toBe(true);
        expect(report).toHaveBeenCalledTimes(2);
        expect(report.mock.calls[1]?.[0]).toBeGreaterThan(oldGeneration);
        reporter.dispose();
    });

    it('preserves the preparation context while rebasing a stale report', async () => {
        const preparation = {
            rendererEpoch: 3,
            showEpoch: 5,
            hostEpoch: 8,
        };
        const report = vi
            .fn(
                (
                    generation: number,
                    context: typeof preparation | undefined
                ): SearchWindowRegionUpdate => {
                    expect(context).toBe(preparation);
                    return appliedUpdate(generation);
                }
            )
            .mockImplementationOnce((generation: number) => ({
                status: 'stale',
                requestedGeneration: generation,
                activeGeneration: generation + 10,
            }));
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'prepared-geometry', context: preparation, report }),
            100
        );

        await expect(reporter.flush('prepare', true)).resolves.toBe(true);

        expect(report.mock.calls.map(([, context]) => context)).toEqual([preparation, preparation]);
        reporter.dispose();
    });

    it('keeps preparation context for a flush queued behind a native region write', async () => {
        const preparation = surfacePreparation();
        const firstReport = deferred<SearchWindowRegionUpdate>();
        const report = vi
            .fn<
                (
                    generation: number,
                    context: SearchSurfacePreparation | undefined
                ) => SearchWindowRegionUpdate | Promise<SearchWindowRegionUpdate>
            >()
            .mockImplementationOnce(() => firstReport.promise)
            .mockImplementation((generation) => appliedUpdate(generation));
        const reporter = createSearchWindowRegionReporter<SearchSurfacePreparation>(
            () => ({ signature: 'prepared-geometry', report }),
            100
        );

        reporter.schedule('layout-change', true, true);
        await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));

        const preparedFlush = reporter.flush('prepare', true, preparation);

        firstReport.resolve(appliedUpdate(report.mock.calls[0]![0] as number));

        await expect(preparedFlush).resolves.toBe(true);
        expect(report.mock.calls).toHaveLength(2);
        expect(report.mock.calls[0]?.[1]).toBeUndefined();
        expect(report.mock.calls[1]?.[1]).toBe(preparation);
        reporter.dispose();
    });

    it('passes preparation context to the resolver while the surface is hidden', async () => {
        const preparation = surfacePreparation();
        const report = successfulReport();
        const resolveReport = vi.fn(
            (
                context?: SearchSurfacePreparation
            ): SearchWindowRegionReport<SearchSurfacePreparation> | null =>
                context ? { signature: 'prepared-geometry', report } : null
        );
        const reporter = createSearchWindowRegionReporter<SearchSurfacePreparation>(
            resolveReport,
            100
        );

        await expect(reporter.flush('prepare', true, preparation)).resolves.toBe(true);

        expect(resolveReport).toHaveBeenCalledWith(preparation);
        expect(report).toHaveBeenCalledWith(expect.any(Number), preparation);
        reporter.dispose();
    });

    it('rejects a tokenized applied acknowledgement without a shown commit', async () => {
        const preparation = surfacePreparation();
        const report = vi.fn((generation: number, context: SearchSurfacePreparation | undefined) =>
            validateSearchSurfacePreparationUpdate(appliedUpdate(generation), context, generation)
        );
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'prepared-geometry', context: preparation, report }),
            100
        );

        await expect(reporter.flush('prepare', true)).rejects.toThrow(
            'Search surface preparation acknowledgement is invalid'
        );
        reporter.dispose();
    });

    it('rejects a tokenized shown commit with mismatched causal facts', async () => {
        const preparation = surfacePreparation();
        const report = vi.fn((generation: number, context: SearchSurfacePreparation | undefined) =>
            validateSearchSurfacePreparationUpdate(
                {
                    status: 'applied',
                    generation,
                    showStatus: {
                        status: 'shown',
                        rendererEpoch: preparation.rendererEpoch,
                        showEpoch: preparation.showEpoch,
                        hostEpoch: preparation.hostEpoch + 1,
                        generation,
                    },
                },
                context,
                generation
            )
        );
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'prepared-geometry', context: preparation, report }),
            100
        );

        await expect(reporter.flush('prepare', true)).rejects.toThrow(
            'Search surface preparation acknowledgement is invalid'
        );
        reporter.dispose();
    });

    it('accepts only a matching shown commit for a tokenized applied acknowledgement', async () => {
        const preparation = surfacePreparation();
        const report = vi.fn((generation: number, context: SearchSurfacePreparation | undefined) =>
            validateSearchSurfacePreparationUpdate(
                {
                    status: 'applied',
                    generation,
                    showStatus: {
                        status: 'shown',
                        rendererEpoch: preparation.rendererEpoch,
                        showEpoch: preparation.showEpoch,
                        hostEpoch: preparation.hostEpoch,
                        generation,
                    },
                },
                context,
                generation
            )
        );
        const reporter = createSearchWindowRegionReporter(
            () => ({ signature: 'prepared-geometry', context: preparation, report }),
            100
        );

        await expect(reporter.flush('prepare', true)).resolves.toBe(true);
        reporter.dispose();
    });

    it('keeps ordinary applied acknowledgements compatible without preparation context', () => {
        expect(validateSearchSurfacePreparationUpdate(appliedUpdate(7), undefined, 7)).toEqual(
            appliedUpdate(7)
        );
    });
});
