import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture, network, response } from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

const windows: ReturnType<typeof initializeAgentWindow>[] = [];
afterEach(async () => {
    await Promise.all(windows.splice(0).map((window) => window.dispose()));
});

async function setup() {
    const fixture = createAgentWindowFixture();
    windows.push(fixture.window);
    await fixture.window.ready;
    await fixture.window.capabilities.waitForAgent();
    mockWindows('settings');
    const client = initializeAgentWindow();
    windows.push(client);
    return { ...fixture, client };
}

describe('given the production main computer-control owner and settings client', () => {
    it('user given computer preferences when saving concurrent fields then reads both committed values through main', async () => {
        const { database, client } = await setup();
        await Promise.all([
            client.computer.saveSettings({ cursorVisible: false }),
            client.computer.saveSettings({ maxImageDimension: 2048 }),
        ]);
        expect(await client.computer.loadSettings()).toMatchObject({
            cursorVisible: false,
            maxImageDimension: 2048,
        });
        expect(
            JSON.parse(
                database
                    .prepare("SELECT value FROM settings WHERE key = 'computer_use.settings'")
                    .get()!.value as string
            )
        ).toMatchObject({ cursorVisible: false, maxImageDimension: 2048, approval: 'each' });
    });

    it('user given enabled computer control when disabling in settings then the following production turn omits it', async () => {
        const { window, client } = await setup();
        await client.computer.setEnabled(true);
        network.replies.push(response('Before'));
        await (
            await window.api.startTask({ prompt: 'Before' })
        ).completion;
        expect(JSON.stringify(network.requests[0]!.tools)).toContain('computer_use');
        await client.computer.setEnabled(false);
        network.replies.push(response('After'));
        await (
            await window.api.startTask({ prompt: 'After' })
        ).completion;
        expect(JSON.stringify(network.requests[1]!.tools)).not.toContain('computer_use');
    });

    it('user given a failed driver query when refreshing then observes the failure and can query again', async () => {
        const { client } = await setup();
        mockTauriCommand('computer_use_status', () => {
            throw new Error('driver unavailable');
        });
        await expect(client.computer.status('cua-driver')).rejects.toThrow(
            'COMPUTER_COMMAND_FAILED'
        );
        mockTauriCommand('computer_use_status', {
            installed: true,
            driver_version: '1.0',
            error: null,
        });
        expect(await client.computer.status('cua-driver')).toMatchObject({
            installed: true,
            driverVersion: '1.0',
        });
    });

    it('user given a detached settings client when saving then no later native or persisted effect starts', async () => {
        const { database, client } = await setup();
        await client.dispose();
        await expect(client.computer.saveSettings({ approval: 'full-access' })).rejects.toThrow(
            'COMPUTER_COMMAND_UNAVAILABLE'
        );
        expect(
            database.prepare("SELECT value FROM settings WHERE key = 'computer_use.settings'").get()
        ).toBeUndefined();
        expect(getTauriInvokeCalls().some((call) => call.cmd === 'computer_use_invoke')).toBe(
            false
        );
    });

    it('user given a secondary window without main when querying then fails within its deadline without a fallback', async () => {
        vi.useFakeTimers();
        mockWindows('settings');
        const client = initializeAgentWindow();
        windows.push(client);
        const result = expect(client.computer.loadSettings()).rejects.toThrow(
            'COMPUTER_COMMAND_UNCONFIRMED'
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await result;
        expect(
            getTauriInvokeCalls().some(
                (call) => call.cmd === 'computer_use_status' || call.cmd === 'computer_use_invoke'
            )
        ).toBe(false);
    });
});
