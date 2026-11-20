import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import { analytics } from '@/platform/native/analytics';

describe('given the native analytics bridge', () => {
    it('user gets the analytics state from the namespaced command', async () => {
        mockTauriCommand('analytics_get_state', {
            status: 'enabled',
            consentEpoch: 3,
            queueDepth: 0,
            pendingBytes: 0,
            buildEligible: true,
            transportReady: true,
        });

        const state = await analytics.getState();

        expect(getLastTauriInvokeCall('analytics_get_state')).toEqual({
            cmd: 'analytics_get_state',
            payload: undefined,
        });
        expect(state.buildEligible).toBe(true);
        expect(state.transportReady).toBe(true);
        expect(state.consentEpoch).toBe(3);
    });

    it('user sends the toggle with the expected consent epoch', async () => {
        mockTauriCommand('analytics_set_enabled', {
            status: 'disabled',
            consentEpoch: 4,
            queueDepth: 0,
            pendingBytes: 0,
            buildEligible: true,
            transportReady: true,
        });

        await analytics.setEnabled(false, 3);

        expect(getLastTauriInvokeCall('analytics_set_enabled')).toEqual({
            cmd: 'analytics_set_enabled',
            payload: {
                enabled: false,
                expectedConsentEpoch: 3,
            },
        });
    });

    it('user clears pending data with the expected consent epoch', async () => {
        mockTauriCommand('analytics_clear_pending', {
            status: 'enabled',
            consentEpoch: 4,
            queueDepth: 0,
            pendingBytes: 0,
            buildEligible: true,
            transportReady: true,
        });

        await analytics.clearPending(4);

        expect(getLastTauriInvokeCall('analytics_clear_pending')).toEqual({
            cmd: 'analytics_clear_pending',
            payload: {
                expectedConsentEpoch: 4,
            },
        });
    });

    it('user gets the track request passed to the native command and its result back', async () => {
        mockTauriCommand('analytics_track', { status: 'queued', eventId: 'e-1' });
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

        expect(getLastTauriInvokeCall('analytics_track')).toEqual({
            cmd: 'analytics_track',
            payload: { request },
        });
        expect(result.eventId).toBe('e-1');
    });

    it('user flushes through the native command without a payload', async () => {
        mockTauriCommand('analytics_flush', undefined);

        await analytics.flush();

        expect(getLastTauriInvokeCall('analytics_flush')).toEqual({
            cmd: 'analytics_flush',
            payload: undefined,
        });
    });

    it('user gets the native lifecycle context from the namespaced command', async () => {
        mockTauriCommand('analytics_get_lifecycle_context', {
            runId: 'run-1',
            startupId: 'run-1',
            startupKind: 'cold',
            startupSource: 'foreground',
            elapsedMs: 12,
        });

        const context = await analytics.getLifecycleContext();

        expect(getLastTauriInvokeCall('analytics_get_lifecycle_context')).toEqual({
            cmd: 'analytics_get_lifecycle_context',
            payload: undefined,
        });
        expect(context).toMatchObject({
            runId: 'run-1',
            startupId: 'run-1',
            startupKind: 'cold',
            startupSource: 'foreground',
            elapsedMs: 12,
        });
    });

    it('user gets an operation handle from the native runtime', async () => {
        mockTauriCommand('analytics_begin_operation', {
            operationId: 'op-1',
            enabled: true,
            consentEpoch: 2,
        });

        const handle = await analytics.beginOperation(1_760_000_000_123);

        expect(getLastTauriInvokeCall('analytics_begin_operation')).toEqual({
            cmd: 'analytics_begin_operation',
            payload: {
                startedAtMs: 1_760_000_000_123,
            },
        });
        expect(handle.operationId).toBe('op-1');
    });

    it('user releases an operation handle with its id', async () => {
        mockTauriCommand('analytics_complete_operation', undefined);

        await analytics.completeOperation('op-1');

        expect(getLastTauriInvokeCall('analytics_complete_operation')).toEqual({
            cmd: 'analytics_complete_operation',
            payload: {
                operationId: 'op-1',
            },
        });
    });

    it('user gets the native error propagated instead of a silent success', async () => {
        mockTauriCommand('analytics_clear_pending', () => {
            throw new Error('stale_consent_epoch');
        });

        await expect(analytics.clearPending(1)).rejects.toThrow('stale_consent_epoch');
    });
});
