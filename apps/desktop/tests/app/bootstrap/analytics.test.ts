import { mockWindows } from '@tauri-apps/api/mocks';
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

import { createAgentWindowFixture } from '../../utils/agentWindow';
import { deferred, installProductAnalytics } from '../../utils/productAnalytics';
import { getTauriInvokeCalls, mockTauriCommand } from '../../utils/tauri';

describe('given actual windows have separate best-effort product observers', () => {
    it('user completes a copy in another window when one observer has exhausted its stalled admission budget', async () => {
        vi.useFakeTimers();
        const fixture = createAgentWindowFixture();
        mockWindows('settings');
        const settings = initializeAgentWindow();
        const capture = deferred<{ operationId: string; enabled: boolean; consentEpoch: number }>();
        mockTauriCommand('analytics_begin_operation', () => capture.promise);
        const first = Array.from({ length: 100 }, () =>
            fixture.window.productAnalytics.runResultAction('copy_code', async () => 'copied')
        );
        await Promise.all(first);
        expect(getTauriInvokeCalls('analytics_begin_operation')).toHaveLength(16);

        const telemetry = installProductAnalytics();
        await expect(
            settings.productAnalytics.runResultAction('copy_answer', async () => 'other copy')
        ).resolves.toBe('other copy');
        await flushPromises();
        expect(telemetry.events).toEqual([
            expect.objectContaining({
                eventName: 'result.action_completed',
                attributes: expect.objectContaining({ action: 'copy_answer', result: 'success' }),
            }),
        ]);
        await vi.advanceTimersByTimeAsync(100);
        capture.resolve({ operationId: 'late-first-window', enabled: true, consentEpoch: 1 });
        await flushPromises();
        await settings.dispose();
        await fixture.window.dispose();
    });

    it('user leaves a window while a consent capture is pending and its late handle is released without submitting an event', async () => {
        const fixture = createAgentWindowFixture();
        await fixture.window.ready;
        const capture = deferred<{ operationId: string; enabled: boolean; consentEpoch: number }>();
        mockTauriCommand('analytics_begin_operation', () => capture.promise);
        mockTauriCommand('analytics_complete_operation', undefined);
        await fixture.window.productAnalytics.runResultAction('copy_code', async () => 'copied');
        await fixture.window.dispose();
        capture.resolve({ operationId: 'late-disposed-window', enabled: true, consentEpoch: 1 });
        await flushPromises();

        expect(getTauriInvokeCalls('analytics_track')).toEqual([]);
        expect(
            getTauriInvokeCalls('analytics_complete_operation').map((call) => call.payload)
        ).toEqual([{ operationId: 'late-disposed-window' }]);
        await expect(
            fixture.window.productAnalytics.runResultAction('copy_code', async () => 'still copied')
        ).resolves.toBe('still copied');
        expect(getTauriInvokeCalls('analytics_begin_operation')).toHaveLength(1);
    });

    it('user gets privacy-choice access only in Settings while ordinary clients expose only product observations', async () => {
        const fixture = createAgentWindowFixture();
        mockWindows('tray-menu');
        const tray = initializeAgentWindow();
        mockWindows('settings');
        const settings = initializeAgentWindow();
        expect(fixture.window.analyticsPreferences).toBeUndefined();
        expect(tray.analyticsPreferences).toBeUndefined();
        expect(settings.analyticsPreferences).toBeDefined();
        expect(fixture.window.productAnalytics).not.toHaveProperty('track');
        expect(fixture.window.productAnalytics).not.toHaveProperty('setEnabled');
        expect(settings.productAnalytics).not.toHaveProperty('setEnabled');
        mockTauriCommand('analytics_get_state', {
            status: 'enabled',
            consentEpoch: 7,
            queueDepth: 42,
            pendingBytes: 500,
            buildEligible: true,
            transportReady: true,
        });
        expect(await settings.analyticsPreferences!.getChoice()).toEqual({
            status: 'enabled',
            consentEpoch: 7,
            canEnable: true,
        });
        await tray.dispose();
        await settings.dispose();
        await fixture.window.dispose();
    });
});
