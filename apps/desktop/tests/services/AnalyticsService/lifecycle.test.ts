import {
    beginUpdateOperation,
    boundedVersion,
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
                consentEpoch: 3,
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
        nativeAnalytics.getState.mockResolvedValue(state({ status: 'disabled' }));
        const update = await beginUpdateOperation();

        await trackUpdateTransition(update, 'check_started', { result: 'success', source: 'user' });

        expect(nativeAnalytics.track).not.toHaveBeenCalled();
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
