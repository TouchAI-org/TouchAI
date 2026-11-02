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
    it('user reads the driver status through the status command', async () => {
        mockTauriCommand('computer_use_status', STATUS);

        await expect(computerUse.status()).resolves.toEqual(STATUS);
    });

    it('user installs the driver through the prepare command', async () => {
        mockTauriCommand('computer_use_prepare', STATUS);

        await expect(computerUse.prepare()).resolves.toEqual(STATUS);
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

    it('user releases the runtime', async () => {
        mockTauriCommand('computer_use_shutdown', null);

        await expect(computerUse.shutdown()).resolves.toBeNull();
    });
});
