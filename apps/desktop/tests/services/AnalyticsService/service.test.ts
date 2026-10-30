import { analytics } from '@services/AnalyticsService';
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

const validAttributes = {
    run_id: '92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09',
    startup_source: 'foreground',
};

describe('AnalyticsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user gets a persisted result when the native channel accepts the event', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ consentEpoch: 5 }));
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-1' });

        const result = await analytics.track('app.started', validAttributes);

        expect(result.status).toBe('persisted');
        expect(nativeAnalytics.track).toHaveBeenCalledWith({
            eventName: 'app.started',
            occurredAtMs: expect.any(Number),
            consentEpoch: 5,
            attributes: validAttributes,
        });
    });

    it('user gets a disabled result without a native call when statistics are off', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ status: 'disabled' }));

        const result = await analytics.track('app.started', validAttributes);

        expect(result.status).toBe('disabled');
        expect(nativeAnalytics.track).not.toHaveBeenCalled();
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

    it('user gets the epoch captured at start so a completion cannot borrow a newer consent', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ consentEpoch: 7 }));
        const operation = await analytics.beginOperation();
        expect(operation).toMatchObject({ enabled: true, consentEpoch: 7 });

        // A disable/re-enable elsewhere moves the live epoch; the in-flight
        // operation must still carry the epoch it started with.
        nativeAnalytics.getState.mockResolvedValue(state({ consentEpoch: 9 }));
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-2' });

        await analytics.track('app.started', validAttributes, { operation });

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({ consentEpoch: 7 })
        );
    });

    it('user gets a disabled handle when the operation starts while off', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ status: 'disabled' }));

        const operation = await analytics.beginOperation();

        expect(operation.enabled).toBe(false);
        const result = await analytics.track('app.started', validAttributes, { operation });
        expect(result.status).toBe('disabled');
        expect(nativeAnalytics.track).not.toHaveBeenCalled();
    });

    it('user gets a fail-closed handle when the native state cannot be read', async () => {
        nativeAnalytics.getState.mockRejectedValue(new Error('channel down'));

        const operation = await analytics.beginOperation();

        expect(operation).toMatchObject({ enabled: false, consentEpoch: 0 });
    });

    it('user gets an error result when the native channel throws, never a rejection', async () => {
        nativeAnalytics.getState.mockResolvedValue(state());
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
