import { mockWindows } from '@tauri-apps/api/mocks';
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

import { createAgentWindowFixture } from '../../utils/agentWindow';
import { deferred } from '../../utils/productAnalytics';
import { getTauriInvokeCalls, mockTauriCommand } from '../../utils/tauri';

const update = { version: '2.0.0', fileName: 'update.nupkg', notes: null, sizeBytes: null };
const result = {
    status: 'available',
    channel: 'stable',
    currentVersion: '1.0.0',
    latest: null,
    update,
    requirement: {
        required: false,
        minimumSupportedVersion: null,
        requiredSeverity: null,
        requiredReason: null,
        targetSatisfiesRequirement: true,
    },
};

async function openWindows() {
    const fixture = createAgentWindowFixture();
    await fixture.window.ready;
    mockWindows('settings');
    const settings = initializeAgentWindow();
    return { ...fixture, settings };
}

describe('given production windows share one main update owner', () => {
    it('user checks from Settings while main is checking and both observe one native decision', async () => {
        const fixture = await openWindows();
        const checked = deferred<typeof result>();
        mockTauriCommand('updater_check_for_updates', () => checked.promise);
        const first = fixture.window.updates.checkNow('manual');
        const second = fixture.settings.updates.checkNow('settings-open');
        await vi.waitFor(() =>
            expect(getTauriInvokeCalls('updater_check_for_updates')).toHaveLength(1)
        );
        checked.resolve(result);
        const outcomes = await Promise.all([first, second]);
        expect(fixture.window.updates.getState()).toMatchObject({
            status: 'available',
            error: null,
        });
        expect(outcomes).toEqual([true, true]);
        expect(fixture.window.updates.getState()).toMatchObject({
            status: 'available',
            availableUpdate: update,
        });
        expect(fixture.settings.updates.getState()).toEqual(fixture.window.updates.getState());
        expect(
            fixture.database
                .prepare('SELECT value FROM settings WHERE key = ?')
                .get('app_update_last_checked_at')?.value
        ).toBeTruthy();
        await fixture.settings.dispose();
        await fixture.window.dispose();
    });

    it('user installs the selected update through Settings and main retains native package identity', async () => {
        const fixture = await openWindows();
        mockTauriCommand('updater_check_for_updates', result);
        mockTauriCommand('updater_download_update', update);
        mockTauriCommand('updater_install_update', true);
        await fixture.settings.updates.checkNow('manual');
        await expect(fixture.settings.updates.download()).resolves.toBe(true);
        await expect(fixture.settings.updates.install()).resolves.toBe(true);
        expect(getTauriInvokeCalls('updater_install_update').map((call) => call.payload)).toEqual([
            expect.objectContaining({
                channel: 'stable',
                version: update.version,
                fileName: update.fileName,
                analytics: expect.objectContaining({
                    updateOperationId: expect.any(String),
                    source: 'user',
                }),
            }),
        ]);
        await fixture.settings.dispose();
        await fixture.window.dispose();
    });

    it('user gets update preferences only in Settings and an auxiliary window cannot start native effects', async () => {
        const fixture = await openWindows();
        mockWindows('tray-menu');
        const tray = initializeAgentWindow();
        expect(fixture.window.updatePreferences).toBeUndefined();
        expect(fixture.settings.updatePreferences).toBeDefined();
        expect(tray.updatePreferences).toBeUndefined();
        await expect(tray.updates.checkNow('manual')).rejects.toThrow('UPDATES_UNAVAILABLE');
        expect(getTauriInvokeCalls('updater_check_for_updates')).toEqual([]);
        await tray.dispose();
        await fixture.settings.dispose();
        await fixture.window.dispose();
    });

    it('user closes main during a check and its late reply cannot save a detached completion or start a replacement owner', async () => {
        vi.useFakeTimers();
        const fixture = await openWindows();
        const checked = deferred<typeof result>();
        mockTauriCommand('updater_check_for_updates', () => checked.promise);
        const checking = fixture.settings.updates.checkNow('manual');
        const outcome = checking.catch((error: unknown) => error);
        await flushPromises();
        expect(getTauriInvokeCalls('updater_check_for_updates')).toHaveLength(1);
        await fixture.window.dispose();
        checked.resolve(result);
        await flushPromises();
        await vi.advanceTimersByTimeAsync(60_001);
        expect(await outcome).toBeInstanceOf(Error);
        expect(
            fixture.database
                .prepare('SELECT value FROM settings WHERE key = ?')
                .get('app_update_last_checked_at')?.value
        ).toBe('');
        expect(fixture.settings.updates.getState().status).not.toBe('available');
        await fixture.settings.dispose();
        expect(getTauriInvokeCalls('updater_check_for_updates')).toHaveLength(1);
    });
});
