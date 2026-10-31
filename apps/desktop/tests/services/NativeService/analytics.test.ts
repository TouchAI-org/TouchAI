import { analytics } from '@services/NativeService/analytics';
import { invoke } from '@services/NativeService/invoke';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the Tauri invoke boundary; the production wrapper under test is real.
vi.mock('@services/NativeService/invoke', () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

describe('NativeService analytics bridge', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
    });

    it('user gets the analytics state from the namespaced command', async () => {
        mockInvoke.mockResolvedValue({
            status: 'enabled',
            consentEpoch: 3,
            queueDepth: 0,
            pendingBytes: 0,
            transportReady: true,
        });

        const state = await analytics.getState();

        expect(mockInvoke).toHaveBeenCalledWith('analytics_get_state');
        expect(state.transportReady).toBe(true);
        expect(state.consentEpoch).toBe(3);
    });

    it('user sends the toggle with the expected consent epoch', async () => {
        mockInvoke.mockResolvedValue({
            status: 'disabled',
            consentEpoch: 4,
            queueDepth: 0,
            pendingBytes: 0,
            transportReady: true,
        });

        await analytics.setEnabled(false, 3);

        expect(mockInvoke).toHaveBeenCalledWith('analytics_set_enabled', {
            enabled: false,
            expectedConsentEpoch: 3,
        });
    });

    it('user clears pending data with the expected consent epoch', async () => {
        mockInvoke.mockResolvedValue({
            status: 'enabled',
            consentEpoch: 4,
            queueDepth: 0,
            pendingBytes: 0,
            transportReady: true,
        });

        await analytics.clearPending(4);

        expect(mockInvoke).toHaveBeenCalledWith('analytics_clear_pending', {
            expectedConsentEpoch: 4,
        });
    });

    it('user gets the track request passed to the native command and its result back', async () => {
        mockInvoke.mockResolvedValue({ status: 'persisted', eventId: 'e-1' });
        const request = {
            eventName: 'app.started' as const,
            occurredAtMs: 1_760_000_000_000,
            operationId: 'op-1',
            attributes: {
                run_id: '92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09',
                startup_source: 'foreground',
            },
        };

        const result = await analytics.track(request);

        expect(mockInvoke).toHaveBeenCalledWith('analytics_track', { request });
        expect(result.eventId).toBe('e-1');
    });

    it('user flushes through the native command without a payload', async () => {
        mockInvoke.mockResolvedValue(undefined);

        await analytics.flush();

        expect(mockInvoke).toHaveBeenCalledWith('analytics_flush');
    });

    it('user gets the native lifecycle context from the namespaced command', async () => {
        mockInvoke.mockResolvedValue({
            runId: 'run-1',
            startupId: 'run-1',
            startupKind: 'cold',
            startupSource: 'foreground',
            elapsedMs: 12,
        });

        const context = await analytics.getLifecycleContext();

        expect(mockInvoke).toHaveBeenCalledWith('analytics_get_lifecycle_context');
        expect(context).toMatchObject({
            runId: 'run-1',
            startupId: 'run-1',
            startupKind: 'cold',
            startupSource: 'foreground',
            elapsedMs: 12,
        });
    });

    it('user gets an operation handle from the native runtime', async () => {
        mockInvoke.mockResolvedValue({
            operationId: 'op-1',
            enabled: true,
            consentEpoch: 2,
        });

        const handle = await analytics.beginOperation();

        expect(mockInvoke).toHaveBeenCalledWith('analytics_begin_operation');
        expect(handle.operationId).toBe('op-1');
    });

    it('user releases an operation handle with its id', async () => {
        mockInvoke.mockResolvedValue(undefined);

        await analytics.completeOperation('op-1');

        expect(mockInvoke).toHaveBeenCalledWith('analytics_complete_operation', {
            operationId: 'op-1',
        });
    });

    it('user gets the native error propagated instead of a silent success', async () => {
        mockInvoke.mockRejectedValue(new Error('stale_consent_epoch'));

        await expect(analytics.clearPending(1)).rejects.toThrow('stale_consent_epoch');
    });
});
