import { computerUse } from '@services/NativeService/computerUse';
import { installTauriMocks, mockTauriCommand, resetTauriMocks } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/*
 * The native bridge is a thin wrapper, but every command name and payload shape
 * is a contract with Rust. A typo here fails at runtime with an "unknown
 * command" error, so each method is exercised once against the mocked IPC.
 */

const STATUS = {
    abi_version: '1.1.0',
    binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
    driver_version: '0.38.0',
    installed_size_bytes: 32842600,
    error: null,
    installed: true,
};

beforeEach(() => {
    installTauriMocks();
});

afterEach(() => {
    resetTauriMocks();
});

describe('computer use native bridge', () => {
    it('user given an active overlay when its page reloads then receives all current cursors', async () => {
        const feedback = {
            generation: 5,
            activities: [{ id: 'one', ordinal: 1, pointer: { x: 40, y: 50 } }],
            banner: { x: 960, y: 0 },
            locale: 'zh-CN',
        };
        mockTauriCommand('computer_use_glow_snapshot', feedback);
        await expect(computerUse.feedback()).resolves.toEqual(feedback);
    });
    it('user given a driver directory when moving it then receives the persisted native location', async () => {
        let directory = 'C:/drivers';
        mockTauriCommand('computer_use_driver_directory', () => directory);
        mockTauriCommand('computer_use_set_driver_directory', (payload: { directory: string }) => {
            directory = payload.directory;
            return directory;
        });
        await expect(computerUse.driverDirectory()).resolves.toBe('C:/drivers');
        await expect(computerUse.setDriverDirectory('D:/驱动')).resolves.toBe('D:/驱动');
        await expect(computerUse.driverDirectory()).resolves.toBe('D:/驱动');
    });
    it('user given a second driver when installing and discovering then reaches that driver explicitly', async () => {
        const received: unknown[] = [];
        mockTauriCommand('computer_use_prepare', (payload: unknown) => {
            received.push(payload);
            return STATUS;
        });
        mockTauriCommand('computer_use_list_tools', (payload: unknown) => {
            received.push(payload);
            return [];
        });
        await computerUse.prepare('agent-desktop');
        await computerUse.listTools('agent-desktop');
        expect(received).toEqual([{ driver: 'agent-desktop' }, { driver: 'agent-desktop' }]);
    });
    it('user given active computer actions when turning control off then requests cancellation for all actions', async () => {
        mockTauriCommand('computer_use_cancel_all', 2);
        await expect(computerUse.cancelAll()).resolves.toBe(2);
    });
    it('user given an installed driver when discovering tools then receives the original schemas', async () => {
        const tools = [
            { name: 'run_steps', inputSchema: { type: 'object' }, description: 'Run a sequence' },
        ];
        mockTauriCommand('computer_use_list_tools', tools);
        await expect(computerUse.listTools()).resolves.toEqual(tools);
    });
    it('user reads the driver status through the status command', async () => {
        mockTauriCommand('computer_use_status', STATUS);

        await expect(computerUse.status()).resolves.toEqual(STATUS);
    });

    it('user installs the driver through the prepare command', async () => {
        mockTauriCommand('computer_use_prepare', STATUS);

        await expect(computerUse.prepare()).resolves.toEqual(STATUS);
    });

    it('user gets the computer-use glow requested through the native bridge', async () => {
        mockTauriCommand('computer_use_glow_pulse', null);

        await expect(computerUse.pulseGlow()).resolves.toBeNull();
    });

    it('user given a desktop task when starting and finishing control then receives activity feedback for that task', async () => {
        const changes: unknown[] = [];
        mockTauriCommand('computer_use_glow_set_active', (payload: unknown) =>
            changes.push(payload)
        );
        await computerUse.setActivity('desktop-task', true);
        await computerUse.setActivity('desktop-task', false);
        expect(changes).toEqual([
            { activityId: 'desktop-task', active: true },
            { activityId: 'desktop-task', active: false },
        ]);
    });

    it('user given active control when a pointer moves then receives coordinates linked to the same task', async () => {
        let received: unknown;
        mockTauriCommand('computer_use_glow_pulse', (payload: unknown) => {
            received = payload;
        });
        await computerUse.pulseGlow({ x: 10, y: 20 }, 'desktop-task');
        expect(received).toEqual({ pointer: { x: 10, y: 20 }, activityId: 'desktop-task' });
    });

    it('user runs one action with its execution id', async () => {
        mockTauriCommand('computer_use_invoke', { ok: true });

        await expect(
            computerUse.call({
                arguments: { pid: 1, window_id: 2 },
                executionId: 'exec-1',
                tool: 'click',
            })
        ).resolves.toEqual({ ok: true });
    });

    it('user cancels the running action by execution id', async () => {
        mockTauriCommand('computer_use_cancel', true);

        await expect(computerUse.cancel('exec-1')).resolves.toBe(true);
    });

    it('user checks for a newer driver version', async () => {
        mockTauriCommand('computer_use_check_update', {
            current: '0.38.0',
            error: null,
            latest: '0.39.0',
            update_available: true,
        });

        await expect(computerUse.checkUpdate()).resolves.toEqual({
            current: '0.38.0',
            error: null,
            latest: '0.39.0',
            update_available: true,
        });
    });

    it('user given a newer driver when installing it then sends the driver and version', async () => {
        const received: unknown[] = [];
        mockTauriCommand('computer_use_install_update', (payload: unknown) => {
            received.push(payload);
            return STATUS;
        });

        await expect(computerUse.installUpdate('cua-driver', '0.39.0')).resolves.toEqual(STATUS);
        expect(received).toEqual([{ driver: 'cua-driver', version: '0.39.0' }]);
    });

    it('user removes the downloaded driver', async () => {
        mockTauriCommand('computer_use_remove', true);

        await expect(computerUse.remove()).resolves.toBe(true);
    });

    it('user pushes behaviour settings into the driver', async () => {
        mockTauriCommand('computer_use_apply_settings', []);

        await expect(
            computerUse.applySettings({ cursorVisible: true, maxImageDimension: 1568 })
        ).resolves.toEqual([]);
    });

    it('user turns trajectory recording on and off', async () => {
        mockTauriCommand('computer_use_set_recording', true);

        await expect(computerUse.setRecording(true)).resolves.toBe(true);
    });

    it('user given a chosen recording folder when enabling then forwards it to the native recorder', async () => {
        let received: unknown;
        mockTauriCommand('computer_use_set_recording', (payload: unknown) => {
            received = payload;
            return true;
        });
        await expect(computerUse.setRecording(true, 'C:/用户记录/电脑控制')).resolves.toBe(true);
        expect(received).toEqual({ enabled: true, outputDir: 'C:/用户记录/电脑控制' });
    });

    it('user releases the runtime', async () => {
        mockTauriCommand('computer_use_shutdown', null);

        await expect(computerUse.shutdown()).resolves.toBeNull();
    });
});
