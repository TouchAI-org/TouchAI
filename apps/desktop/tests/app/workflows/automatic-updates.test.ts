import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

let fixture: ReturnType<typeof createAgentWindowFixture> | undefined;
let finishCheck: (() => void) | undefined;
afterEach(async () => {
    finishCheck?.();
    finishCheck = undefined;
    await flushPromises();
    await fixture?.window.dispose();
    fixture = undefined;
    vi.useRealTimers();
});
const result = {
    status: 'not_available',
    channel: 'stable',
    currentVersion: '1.2.3',
    latest: null,
    requirement: {
        required: false,
        minimumSupportedVersion: null,
        requiredSeverity: null,
        requiredReason: null,
        targetSatisfiesRequirement: true,
    },
};
async function start(at: Date, savedCheck?: string) {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    fixture = createAgentWindowFixture();
    if (savedCheck)
        fixture.database
            .prepare('INSERT INTO settings (key,value) VALUES (?,?)')
            .run('app_update_last_checked_at', savedCheck);
    mockTauriCommand('updater_check_for_updates', result);
    await fixture.window.ready;
    await fixture.window.settings.initialize();
    fixture.window.startAutomaticUpdateChecks();
    await flushPromises();
    return fixture;
}
const checks = () => getTauriInvokeCalls('updater_check_for_updates');

describe('given main owns automatic update scheduling and the real update controller', () => {
    it('user reconnects and receives one fresh check while a closed main starts no later checks', async () => {
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        await start(new Date(2026, 10, 10, 10));
        expect(checks()).toEqual([]);
        online.mockReturnValue(true);
        window.dispatchEvent(new Event('online'));
        await flushPromises();
        expect(checks()).toHaveLength(1);
        await fixture!.window.dispose();
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(checks()).toHaveLength(1);
    });
    it('user starts during quiet hours and receives the first check at eight followed by hourly checks', async () => {
        await start(new Date(2026, 10, 10, 7, 30));
        expect(checks()).toEqual([]);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        await flushPromises();
        expect(checks()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(3_600_000);
        await flushPromises();
        expect(checks()).toHaveLength(2);
    });
    it('user waits for a slow check and keeps the next one an hour after its completion', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 10, 10));
        fixture = createAgentWindowFixture();
        const completion = Promise.withResolvers<typeof result>();
        finishCheck = () => completion.resolve(result);
        mockTauriCommand('updater_check_for_updates', () => completion.promise);
        await fixture.window.ready;
        await fixture.window.settings.initialize();
        fixture.window.startAutomaticUpdateChecks();
        await flushPromises();
        expect(checks()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        finishCheck();
        await flushPromises();
        await vi.advanceTimersByTimeAsync(3_600_000 - 1);
        await flushPromises();
        expect(checks()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await flushPromises();
        expect(checks()).toHaveLength(2);
    });
    it('user reconnects shortly before the deadline and retains the original hourly check', async () => {
        await start(new Date(2026, 10, 10, 10));
        expect(checks()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(59 * 60_000);
        window.dispatchEvent(new Event('online'));
        await flushPromises();
        expect(checks()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60_000);
        await flushPromises();
        expect(checks()).toHaveLength(2);
    });
    it('user has a stale saved check while offline and never enters an immediate retry loop', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        await start(new Date(2026, 10, 10, 10), new Date(2026, 10, 9, 10).toISOString());
        await vi.advanceTimersByTimeAsync(60_000);
        await flushPromises();
        expect(checks()).toEqual([]);
        expect(fixture!.window.updates.getState().error).toBeNull();
    });
});
