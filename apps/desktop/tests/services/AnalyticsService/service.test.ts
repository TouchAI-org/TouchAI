import { analytics } from '@services/AnalyticsService';
import type { AnalyticsOperationHandle, AnalyticsState } from '@services/AnalyticsService/types';
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

function operation(partial: Partial<AnalyticsOperationHandle> = {}): AnalyticsOperationHandle {
    return {
        operationId: 'op-7',
        enabled: true,
        consentEpoch: 7,
        ...partial,
    };
}

const validAttributes = {
    run_id: '92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09',
    startup_source: 'foreground',
};

describe('AnalyticsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user gets a persisted result when the native channel accepts the event', async () => {
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-1' });

        const result = await analytics.track('app.started', validAttributes);

        expect(result.status).toBe('persisted');
        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'app.started',
                occurredAtMs: expect.any(Number),
                attributes: validAttributes,
            })
        );
    });

    it('user gets a disabled result from the native runtime when statistics are off', async () => {
        nativeAnalytics.track.mockResolvedValue({ status: 'disabled' });

        const result = await analytics.track('app.started', validAttributes);

        expect(result.status).toBe('disabled');
    });

    it('user gets the event rejected before the native channel when an attribute is out of registry', async () => {
        const result = await analytics.track('app.started', {
            run_id: 'not-a-uuid',
            startup_source: 'foreground',
        });

        expect(result.status).toBe('rejected');
        expect(result.reason).toBe('invalid_attributes');
        expect(nativeAnalytics.track).not.toHaveBeenCalled();
    });

    it('user gets the native operation carried on a later completion', async () => {
        nativeAnalytics.beginOperation.mockResolvedValue(operation({ operationId: 'op-9' }));
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-2' });

        const handle = await analytics.beginOperation();
        await analytics.track('app.started', validAttributes, { operation: handle });

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({ operationId: 'op-9' })
        );
    });

    it('user gets a disabled result without a native call when the operation started while off', async () => {
        const result = await analytics.track('app.started', validAttributes, {
            operation: operation({ enabled: false }),
        });

        expect(result.status).toBe('disabled');
        expect(nativeAnalytics.track).not.toHaveBeenCalled();
    });

    it('user gets a fail-closed handle when the native runtime cannot issue one', async () => {
        nativeAnalytics.beginOperation.mockRejectedValue(new Error('channel down'));

        const handle = await analytics.beginOperation();

        expect(handle).toMatchObject({ operationId: '', enabled: false, consentEpoch: 0 });
    });

    it('user gets a completed handle released through the native runtime', async () => {
        nativeAnalytics.completeOperation.mockResolvedValue(undefined);

        await analytics.completeOperation(operation({ operationId: 'op-9' }));

        expect(nativeAnalytics.completeOperation).toHaveBeenCalledWith('op-9');
    });

    it('user gets an error result when the native channel throws, never a rejection', async () => {
        nativeAnalytics.track.mockRejectedValue(new Error('ipc failed'));

        const result = await analytics.track('app.started', validAttributes);

        expect(result.status).toBe('error');
    });

    it('user gets the toggle, clear and flush forwarded to the native runtime', async () => {
        nativeAnalytics.setEnabled.mockResolvedValue(
            state({ status: 'disabled', consentEpoch: 6 })
        );
        nativeAnalytics.clearPending.mockResolvedValue(state());
        nativeAnalytics.flush.mockResolvedValue(undefined);

        await analytics.setEnabled(false, 5);
        await analytics.clearPending(6);
        await analytics.flush();

        expect(nativeAnalytics.setEnabled).toHaveBeenCalledWith(false, 5);
        expect(nativeAnalytics.clearPending).toHaveBeenCalledWith(6);
        expect(nativeAnalytics.flush).toHaveBeenCalled();
    });
});
