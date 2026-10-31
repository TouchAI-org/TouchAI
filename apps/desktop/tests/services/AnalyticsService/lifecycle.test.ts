import {
    beginUpdateOperation,
    boundedVersion,
    finishUpdateOperation,
    trackUpdateTransition,
} from '@services/AnalyticsService/lifecycle';
import type { AnalyticsState } from '@services/AnalyticsService/types';
import { native } from '@services/NativeService';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/NativeService', () => ({
    native: {
        analytics: {
            getState: vi.fn(),
            setEnabled: vi.fn(),
            clearPending: vi.fn(),
            track: vi.fn(),
            flush: vi.fn(),
            beginOperation: vi.fn(),
            completeOperation: vi.fn(),
        },
    },
}));

const nativeAnalytics = vi.mocked(native.analytics);

function state(partial: Partial<AnalyticsState> = {}): AnalyticsState {
    return {
        status: 'enabled',
        consentEpoch: 5,
        queueDepth: 0,
        pendingBytes: 0,
        transportReady: true,
        ...partial,
    };
}

describe('user updates the app', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeAnalytics.getState.mockResolvedValue(state({ consentEpoch: 3 }));
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'u-1' });
        nativeAnalytics.beginOperation.mockResolvedValue({
            operationId: 'op-1',
            enabled: true,
            consentEpoch: 3,
        });
        nativeAnalytics.completeOperation.mockResolvedValue(undefined);
    });

    it('user gets the check and download phases correlated to one update operation', async () => {
        const update = await beginUpdateOperation();

        await trackUpdateTransition(update, 'check_started', {
            result: 'success',
            source: 'user',
            fromVersion: '1.2.0',
        });
        await trackUpdateTransition(update, 'download_started', {
            result: 'success',
            source: 'user',
            toVersion: '1.3.0',
        });

        expect(nativeAnalytics.track).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                eventName: 'app.update_transition',
                operationId: 'op-1',
                attributes: {
                    update_operation_id: update.updateOperationId,
                    phase: 'check_started',
                    result: 'success',
                    source: 'user',
                    from_version: '1.2.0',
                },
            })
        );
        expect(nativeAnalytics.track).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                attributes: expect.objectContaining({
                    update_operation_id: update.updateOperationId,
                    phase: 'download_started',
                    to_version: '1.3.0',
                }),
            })
        );
    });

    it('user gets a handoff phase that never claims a completed restart', async () => {
        const update = await beginUpdateOperation();

        await trackUpdateTransition(update, 'install_handoff', {
            result: 'success',
            source: 'background',
            toVersion: '1.3.0',
        });

        const handedOff = nativeAnalytics.track.mock.calls.find(
            ([request]) => request.attributes.phase === 'install_handoff'
        );
        expect(handedOff?.[0].attributes).toMatchObject({
            phase: 'install_handoff',
            result: 'success',
            source: 'background',
        });
        const restarts = nativeAnalytics.track.mock.calls.filter(
            ([request]) => request.attributes.phase === 'restart_confirmed'
        );
        expect(restarts).toHaveLength(0);
    });

    it('user gets a failure phase when a download fails', async () => {
        const update = await beginUpdateOperation();

        await trackUpdateTransition(update, 'download_finished', {
            result: 'failure',
            source: 'user',
            toVersion: '1.3.0',
        });

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                attributes: expect.objectContaining({
                    phase: 'download_finished',
                    result: 'failure',
                }),
            })
        );
    });

    it('user gets no submission when statistics are off', async () => {
        nativeAnalytics.beginOperation.mockResolvedValue({
            operationId: '',
            enabled: false,
            consentEpoch: 0,
        });
        const update = await beginUpdateOperation();

        await trackUpdateTransition(update, 'check_started', { result: 'success', source: 'user' });

        expect(nativeAnalytics.track).not.toHaveBeenCalled();
    });

    it('user gets the update handle released exactly once after the terminal phase', async () => {
        const update = await beginUpdateOperation();

        await trackUpdateTransition(update, 'install_handoff', {
            result: 'success',
            source: 'user',
            fromVersion: '1.2.0',
            toVersion: '1.3.0',
        });
        await finishUpdateOperation(update);
        await finishUpdateOperation(update);

        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
        expect(nativeAnalytics.completeOperation).toHaveBeenCalledWith('op-1');
    });

    it('user gets the update phase queued before its handle is released', async () => {
        const update = await beginUpdateOperation();
        const order: string[] = [];
        nativeAnalytics.track.mockImplementation(async () => {
            order.push('track');
            return { status: 'persisted' };
        });
        nativeAnalytics.completeOperation.mockImplementation(async () => {
            order.push('release');
        });

        const transition = trackUpdateTransition(update, 'download_finished', {
            result: 'failure',
            source: 'user',
        });
        await finishUpdateOperation(update);
        await transition;

        expect(order).toEqual(['track', 'release']);
    });

    it('user gets no native-owned startup or restart event from the update helper', async () => {
        const update = await beginUpdateOperation();

        await trackUpdateTransition(update, 'check_started', { result: 'success', source: 'user' });
        await trackUpdateTransition(update, 'install_handoff', {
            result: 'success',
            source: 'user',
            fromVersion: '1.2.0',
            toVersion: '1.3.0',
        });

        const names = nativeAnalytics.track.mock.calls.map(([request]) => request.eventName);
        const phases = nativeAnalytics.track.mock.calls.map(
            ([request]) => request.attributes.phase
        );
        expect(names).not.toContain('app.started');
        expect(names).not.toContain('app.startup_completed');
        expect(names).not.toContain('analytics.health_reported');
        expect(phases).not.toContain('restart_confirmed');
    });

    it('user gets the handoff phase carrying the real from/to versions and source', async () => {
        const update = await beginUpdateOperation();

        await trackUpdateTransition(update, 'install_handoff', {
            result: 'success',
            source: 'background',
            fromVersion: '1.2.0',
            toVersion: '1.3.0',
        });

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'app.update_transition',
                attributes: expect.objectContaining({
                    phase: 'install_handoff',
                    result: 'success',
                    source: 'background',
                    from_version: '1.2.0',
                    to_version: '1.3.0',
                }),
            })
        );
    });
});

describe('user provides a version string', () => {
    it('user gets an over-long version dropped instead of sent', () => {
        expect(boundedVersion('1.3.0')).toBe('1.3.0');
        expect(boundedVersion('  1.3.0  ')).toBe('1.3.0');
        expect(boundedVersion('')).toBeUndefined();
        expect(boundedVersion(null)).toBeUndefined();
        expect(boundedVersion('x'.repeat(201))).toBeUndefined();
    });
});
