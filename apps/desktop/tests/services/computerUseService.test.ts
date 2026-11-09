import { posix } from 'node:path';

import { setSetting } from '@database/queries/settings';
import { installTauriMocks, resetTauriMocks } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStore = new Map<string, string>();
let toolEnabled = 1;

vi.mock('@database/queries/builtInTools', () => ({
    findBuiltInToolByToolId: async () => ({ id: 1, enabled: toolEnabled }),
    updateBuiltInTool: async (_id: number, patch: { enabled: number }) => {
        toolEnabled = patch.enabled;
        return { id: 1, enabled: toolEnabled };
    },
}));

vi.mock('@database/queries/settings', () => ({
    getSettingValues: async ({ keys }: { keys: string[] }) =>
        Object.fromEntries(keys.map((key) => [key, settingsStore.get(key) ?? null])),
    getSettingValue: vi.fn(async ({ key }: { key: string }) => settingsStore.get(key) ?? null),
    setSetting: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        settingsStore.set(key, value);
        return { key, value };
    }),
}));

const nativeStatus = vi.fn();
const nativeDirectory = vi.fn(async () => 'C:/drivers');
const nativeMoveDirectory = vi.fn(async (directory: string) => directory);
const nativeUpdate = vi.fn();
const nativeInstallUpdate = vi.fn();
const nativeRemove = vi.fn();
const nativeApply = vi.fn();
const nativeRecording = vi.fn();
const nativePulseGlow = vi.fn();
const nativeCancelAll = vi.fn(async () => 0);
const nativeCursorPosition = vi.fn(async () => ({ x: 345, y: -120 }));
const nativeCall = vi.fn(
    async (request: unknown): Promise<Record<string, unknown>> => ({ request })
);

vi.mock('@tauri-apps/api/path', () => ({
    join: async (...parts: string[]) => posix.join(...parts),
}));

vi.mock('@services/NativeService', () => ({
    paths: { getAppDirectoryPath: async () => 'C:/cache' },
    computerUse: {
        driverDirectory: () => nativeDirectory(),
        setDriverDirectory: (directory: string) => nativeMoveDirectory(directory),
        status: (driver: string) => nativeStatus(driver),
        prepare: () => nativeStatus(),
        pulseGlow: (...args: unknown[]) => nativePulseGlow(...args),
        setActivity: vi.fn(async () => undefined),
        checkUpdate: () => nativeUpdate(),
        installUpdate: (driver: string, version: string) => nativeInstallUpdate(driver, version),
        remove: (driver: string) => nativeRemove(driver),
        applySettings: (request: unknown) => nativeApply(request),
        setRecording: (...args: unknown[]) => nativeRecording(...args),
        call: (request: unknown) => nativeCall(request),
        cancel: vi.fn(),
        shutdown: vi.fn(),
        cancelAll: () => nativeCancelAll(),
        cursorPosition: () => nativeCursorPosition(),
    },
}));

const {
    DEFAULT_SETTINGS,
    allowForSession,
    applySettings,
    checkUpdate,
    installUpdate,
    clearSessionApprovals,
    isAllowedForSession,
    loadSettings,
    loadRecordingDirectory,
    saveRecordingDirectory,
    prepare,
    pulseGlow,
    remove,
    saveSettings,
    setRecording,
    status,
    targetKey,
    isEnabled,
    setEnabled,
    loadGroups,
    setGroupEnabled,
    execute,
    startActivity,
    endActivity,
    loadDriver,
    selectDriver,
    saveDriverDirectory,
    loadDriverDirectory,
} = await import('@services/ComputerUseService');

beforeEach(async () => {
    installTauriMocks();
    settingsStore.clear();
    await loadDriver();
    nativeStatus.mockReset();
    nativeDirectory.mockReset().mockResolvedValue('C:/drivers');
    nativeMoveDirectory.mockReset().mockImplementation(async (directory) => directory);
    nativeStatus.mockResolvedValue({ installed: true, error: null });
    nativeUpdate.mockReset();
    nativeInstallUpdate.mockReset();
    nativeRemove.mockReset();
    nativeApply.mockReset();
    nativeRecording.mockReset();
    nativePulseGlow.mockReset();
    nativeCancelAll.mockClear();
    nativeCall.mockReset();
    nativeCall.mockImplementation(async (request: unknown) => ({ request }));
    toolEnabled = 1;
});

afterEach(() => {
    vi.useRealTimers();
    resetTauriMocks();
});

describe('computer control driver selection', () => {
    it.each([status, prepare])(
        'user given a measured installation when requesting driver availability then receives its actual size',
        async (readStatus) => {
            nativeStatus.mockResolvedValue({ installed: true, installed_size_bytes: 32842600 });
            await expect(readStatus()).resolves.toMatchObject({ installedSizeBytes: 32842600 });
            nativeStatus.mockResolvedValue({ installed: false });
            await expect(readStatus()).resolves.toMatchObject({ installedSizeBytes: null });
        }
    );
    it('user given a relocated driver when continuing then reloads behavior settings for the new runtime', async () => {
        await saveSettings({ approval: 'full-access', cursorVisible: false });
        await execute('get_config').result;
        allowForSession('previous-window');
        await expect(loadDriverDirectory()).resolves.toBe('C:/drivers');
        await expect(saveDriverDirectory('D:/drivers')).resolves.toBe('D:/drivers');
        expect(isAllowedForSession('previous-window')).toBe(false);
        nativeCall.mockClear();
        await execute('get_config').result;
        expect(
            nativeCall.mock.calls.map(([request]) => (request as { tool: string }).tool)
        ).toEqual(['set_config', 'set_agent_cursor_enabled', 'get_config']);
    });

    it('user given recording enabled when moving the driver folder then keeps recording after the runtime restarts', async () => {
        await saveSettings({ recordingEnabled: true, maxImageDimension: 1024 });
        nativeRecording.mockClear();
        nativeCall.mockClear();
        await saveDriverDirectory('D:/drivers');
        expect(
            nativeCall.mock.calls.map(([request]) => (request as { tool: string }).tool)
        ).toEqual(['set_config', 'set_agent_cursor_enabled']);
        expect(nativeRecording).toHaveBeenCalledWith(
            true,
            'C:/cache/computer-use-trajectories/cua-driver'
        );
    });

    it('user given another window relocated drivers when continuing then reapplies the saved behavior', async () => {
        await saveSettings({ cursorVisible: false });
        await execute('get_config').result;
        settingsStore.set('computer_use.driver_directory', 'D:/other-window');
        nativeCall.mockClear();
        await execute('get_config').result;
        expect(
            nativeCall.mock.calls.map(([request]) => (request as { tool: string }).tool)
        ).toEqual(['set_config', 'set_agent_cursor_enabled', 'get_config']);
    });
    it.each([
        { installed: false, error: null },
        { installed: true, error: 'Driver unavailable' },
    ])(
        'user given an unavailable driver when selecting then retains the previous usable driver (%j)',
        async (unavailable) => {
            nativeStatus.mockResolvedValue(unavailable);
            allowForSession('current-window');
            await expect(selectDriver('agent-desktop')).rejects.toThrow();
            await expect(loadDriver()).resolves.toBe('cua-driver');
            expect(isAllowedForSession('current-window')).toBe(true);
            expect(nativeCancelAll).not.toHaveBeenCalled();
        }
    );

    it('user given no preference when opening then keeps the existing driver', async () => {
        await expect(loadDriver()).resolves.toBe('cua-driver');
    });

    it('user given another driver when selecting then gets its native actions and an isolated recording location', async () => {
        allowForSession('old-window');
        await selectDriver('agent-desktop');
        await expect(loadDriver()).resolves.toBe('agent-desktop');
        expect(isAllowedForSession('old-window')).toBe(false);
        await expect(loadRecordingDirectory()).resolves.toBe(
            'C:/cache/computer-use-trajectories/agent-desktop'
        );
        const result = await execute('desktop_status').result;
        expect(result).toMatchObject({
            request: { driver: 'agent-desktop', tool: 'desktop_status' },
        });
        expect(
            nativeCall.mock.calls.map(([request]) => (request as { tool: string }).tool)
        ).not.toContain('set_config');
    });

    it('user given a failed preference write when switching then retains the previous driver', async () => {
        vi.mocked(setSetting).mockRejectedValueOnce(new Error('Storage full'));
        await expect(selectDriver('agent-desktop')).rejects.toThrow('Storage full');
        await expect(loadDriver()).resolves.toBe('cua-driver');
    });
});

describe('agent operation cursor feedback', () => {
    it('user given two conversations when using the same driver session name then keeps their native references isolated', async () => {
        await saveSettings({ approval: 'full-access', cursorVisible: false });
        const first = new AbortController();
        const second = new AbortController();
        await startActivity(first.signal);
        await startActivity(second.signal);
        const firstRead = await execute('get_config', { session: 'work' }, first.signal).result;
        const secondRead = await execute('get_config', { session: 'work' }, second.signal).result;
        const repeated = await execute('get_config', { session: 'work' }, first.signal).result;
        const request = (result: Record<string, unknown>) =>
            result.request as { arguments: { session: string }; activityId: string };
        expect(request(firstRead).arguments.session).not.toBe(
            request(secondRead).arguments.session
        );
        expect(request(firstRead).arguments.session).toBe(request(repeated).arguments.session);
        expect(request(firstRead).activityId).not.toBe(request(secondRead).activityId);
        const returnedSession = await execute(
            'get_config',
            { session: request(firstRead).arguments.session },
            first.signal
        ).result;
        expect(request(returnedSession).arguments.session).toBe(
            request(firstRead).arguments.session
        );
        await endActivity(first.signal);
        await endActivity(second.signal);
    });

    it.each([
        ['agent-desktop', 'desktop_click'],
        ['cua-driver', 'type_text'],
        ['cua-driver', 'run_steps'],
        ['cua-driver', 'run_script'],
        ['cua-driver', 'browser_click'],
    ] as const)(
        'user given %s foreground input when %s executes then delegates feedback without additional driver operations',
        async (driver, tool) => {
            vi.useFakeTimers();
            await selectDriver(driver);
            await saveSettings({ cursorVisible: true, allowForeground: true });
            const controller = new AbortController();
            await startActivity(controller.signal);
            let finish: (value: Record<string, unknown>) => void = () => undefined;
            nativeCall.mockImplementation(async (request: unknown) => {
                if ((request as { tool: string }).tool === tool) {
                    return new Promise((resolve) => {
                        finish = resolve;
                    });
                }
                return {};
            });
            const invocation = execute(tool, {}, controller.signal);
            await vi.advanceTimersByTimeAsync(250);
            expect(nativeCall).toHaveBeenCalledWith(
                expect.objectContaining({
                    driver,
                    tool,
                    activityId: expect.any(String),
                    cursorVisible: true,
                })
            );
            expect(
                nativeCall.mock.calls.map(([request]) => (request as { tool: string }).tool)
            ).not.toContain('get_agent_cursor_state');
            expect(nativePulseGlow).not.toHaveBeenCalled();
            finish({});
            await invocation.result;
            await endActivity(controller.signal);
            nativePulseGlow.mockClear();
            await vi.advanceTimersByTimeAsync(1000);
            expect(nativePulseGlow).not.toHaveBeenCalled();
        }
    );
    it('user given hidden cursor feedback when typing then gets the action result without cursor probes', async () => {
        vi.useFakeTimers();
        await saveSettings({ cursorVisible: false });
        await execute('type_text', { text: 'fixture' }).result;
        await vi.advanceTimersByTimeAsync(1000);
        expect(
            nativeCall.mock.calls.map(([request]) => (request as { tool: string }).tool)
        ).not.toContain('get_agent_cursor_state');
        expect(nativePulseGlow).not.toHaveBeenCalled();
    });
});

describe('computer use capability preferences', () => {
    it('user given a session needing recovery when starting it then lifecycle management is not blocked by display settings', async () => {
        await saveSettings({ approval: 'full-access' });
        await execute('start_session', { session: 'recover' }).result;
        expect(nativeCall.mock.calls.map(([request]) => request)).toEqual([
            expect.objectContaining({ tool: 'start_session', arguments: { session: 'recover' } }),
        ]);
    });

    it('user given saved cursor settings when starting a full access session then sees them applied before the action', async () => {
        await saveSettings({
            approval: 'full-access',
            cursorVisible: true,
            maxImageDimension: 900,
        });
        await execute('get_agent_cursor_state', { session: 'cursor-test' }).result;
        expect(nativeCall.mock.calls.map(([request]) => request)).toEqual([
            expect.objectContaining({
                fullAccess: true,
                tool: 'set_config',
                arguments: { max_image_dimension: 900, session: 'cursor-test' },
            }),
            expect.objectContaining({
                fullAccess: true,
                tool: 'set_agent_cursor_enabled',
                arguments: { enabled: false, session: 'cursor-test' },
            }),
            expect.objectContaining({ fullAccess: true, tool: 'get_agent_cursor_state' }),
        ]);
    });

    it('user given an initialized session when repeating an action then avoids redundant settings calls', async () => {
        await saveSettings({ approval: 'full-access' });
        await execute('get_config').result;
        nativeCall.mockClear();
        await execute('get_config').result;
        expect(nativeCall).toHaveBeenCalledTimes(1);
    });

    it('user given full access when executing a driver tool then receives trusted native authorization', async () => {
        await saveSettings({ approval: 'full-access' });
        const result = await execute('kill_app', { pid: 42 }).result;
        expect(result).toMatchObject({
            request: { fullAccess: true, tool: 'kill_app', arguments: { pid: 42 } },
        });
    });
    it('user given an enabled tool when disabling the master switch then disables the registered tool', async () => {
        await setEnabled(false);
        expect(toolEnabled).toBe(0);
        expect(await isEnabled()).toBe(false);
        expect(nativeCancelAll).toHaveBeenCalled();
    });

    it('user given disabled clipboard tools when toggling the master switch then keeps the group preference', async () => {
        await setGroupEnabled('clipboard', false);
        await setEnabled(false);
        await setEnabled(true);
        expect((await loadGroups()).clipboard).toBe(false);
        expect((await loadGroups()).input).toBe(true);
        expect(await isEnabled()).toBe(true);
    });
});

describe('computer use settings', () => {
    it('user given independent preferences when saving them together then retains both changes after reopening', async () => {
        await Promise.all([
            saveSettings({ allowForeground: true }),
            saveSettings({ cursorVisible: false }),
        ]);
        await expect(loadSettings()).resolves.toMatchObject({
            allowForeground: true,
            cursorVisible: false,
        });
    });

    it('user given one failed preference write when another is pending then saves the other change and can retry', async () => {
        vi.mocked(setSetting).mockRejectedValueOnce(new Error('Storage unavailable'));
        const results = await Promise.allSettled([
            saveSettings({ allowForeground: true }),
            saveSettings({ cursorVisible: false }),
        ]);
        expect(results[0]).toMatchObject({ status: 'rejected' });
        expect(results[1]).toMatchObject({ status: 'fulfilled' });
        await expect(loadSettings()).resolves.toMatchObject({
            allowForeground: false,
            cursorVisible: false,
        });
        await saveSettings({ allowForeground: true });
        await expect(loadSettings()).resolves.toMatchObject({
            allowForeground: true,
            cursorVisible: false,
        });
    });

    it('user gets the safe defaults when nothing has been saved', async () => {
        await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
        expect(DEFAULT_SETTINGS.enabled).toBe(false);
        expect(DEFAULT_SETTINGS.telemetryEnabled).toBe(false);
        expect(DEFAULT_SETTINGS.approval).toBe('each');
    });

    it('user keeps a saved choice and gets unknown fields dropped', async () => {
        settingsStore.set(
            'computer_use.settings',
            JSON.stringify({ approval: 'session-window', maxImageDimension: 900, bogus: 1 })
        );

        const loaded = await loadSettings();

        expect(loaded.approval).toBe('session-window');
        expect(loaded.maxImageDimension).toBe(900);
        expect(loaded).not.toHaveProperty('bogus');
    });

    it('user keeps full access after it is saved and loaded again', async () => {
        await saveSettings({ approval: 'full-access' });

        await expect(loadSettings()).resolves.toMatchObject({ approval: 'full-access' });
    });

    it('user gets the safe approval mode when a legacy value is unknown', async () => {
        settingsStore.set(
            'computer_use.settings',
            JSON.stringify({ approval: 'prompt-sometimes' })
        );

        await expect(loadSettings()).resolves.toMatchObject({ approval: 'each' });
    });

    it('user gets a corrupt payload replaced by defaults instead of a crash', async () => {
        settingsStore.set('computer_use.settings', '{not json');

        await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    });

    it('user sees a saved patch merged into the stored settings', async () => {
        await saveSettings({ cursorVisible: false });

        expect(JSON.parse(settingsStore.get('computer_use.settings') ?? '{}')).toMatchObject({
            cursorVisible: false,
            approval: 'each',
        });
    });
});

describe('computer use driver status', () => {
    it('user sees the native snake_case payload mapped to a ready status', async () => {
        nativeStatus.mockResolvedValue({
            abi_version: '1.1.0',
            binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
            driver_version: '0.38.0',
            error: null,
            installed: true,
        });

        await expect(status()).resolves.toEqual({
            abiVersion: '1.1.0',
            binary: 'C:/data/computer-use/0.38.0/cua_driver_sdk.dll',
            driverVersion: '0.38.0',
            installedSizeBytes: null,
            error: null,
            installed: true,
        });
    });

    it('user sees a failed prepare surface the native error', async () => {
        nativeStatus.mockResolvedValue({
            abi_version: null,
            binary: null,
            driver_version: null,
            error: 'download failed after 3 attempts',
            installed: false,
        });

        const result = await prepare();
        expect(result.installed).toBe(false);
        expect(result.error).toBe('download failed after 3 attempts');
    });
});

describe('computer use driver lifecycle', () => {
    it.each([
        ['cua-driver', 'agent-desktop'],
        ['agent-desktop', 'cua-driver'],
    ] as const)(
        'user given two installed drivers when removing active %s then subsequent calls use %s',
        async (active, remaining) => {
            await selectDriver(active);
            nativeRemove.mockImplementation(async (driver: string) => {
                nativeStatus.mockImplementation(async (candidate: string) => ({
                    installed: candidate !== driver,
                    error: null,
                }));
                return true;
            });
            await remove(active);
            await expect(loadDriver()).resolves.toBe(remaining);
            const result = await execute(
                remaining === 'cua-driver' ? 'get_session' : 'desktop_status'
            ).result;
            expect(result).toMatchObject({ request: { driver: remaining } });
        }
    );

    it('user given an inactive driver when removing it then keeps the active driver', async () => {
        await remove('agent-desktop');
        await expect(loadDriver()).resolves.toBe('cua-driver');
    });

    it('user given a removal failure when deleting the active driver then keeps its selection', async () => {
        nativeRemove.mockRejectedValueOnce(new Error('Restart required'));
        await expect(remove('cua-driver')).rejects.toThrow('Restart required');
        await expect(loadDriver()).resolves.toBe('cua-driver');
    });

    it('user given the last usable driver when removing it then does not select another unavailable driver', async () => {
        nativeStatus.mockResolvedValue({ installed: false, error: null });
        await remove('cua-driver');
        await expect(loadDriver()).resolves.toBe('cua-driver');
        await expect(status()).resolves.toMatchObject({ installed: false });
    });

    it('user sees an available update mapped from the native payload', async () => {
        nativeUpdate.mockResolvedValue({
            current: '0.38.0',
            latest: '0.39.0',
            update_available: true,
            error: null,
        });

        await expect(checkUpdate()).resolves.toEqual({
            current: '0.38.0',
            error: null,
            latest: '0.39.0',
            updateAvailable: true,
        });
    });

    it('user sees a failed update check without a latest version', async () => {
        nativeUpdate.mockResolvedValue({
            current: '0.38.0',
            latest: null,
            update_available: false,
            error: 'mirror answered 503',
        });

        const result = await checkUpdate();
        expect(result.updateAvailable).toBe(false);
        expect(result.error).toBe('mirror answered 503');
    });

    it('user given a newer driver when installing then stops running work and reports the new version', async () => {
        nativeInstallUpdate.mockResolvedValue({
            abi_version: '1.1.0',
            binary: 'C:/data/computer-use/0.39.0/cua_driver_sdk.dll',
            driver_version: '0.39.0',
            installed_size_bytes: 33000000,
            error: null,
            installed: true,
        });

        await expect(installUpdate('cua-driver', '0.39.0')).resolves.toEqual({
            abiVersion: '1.1.0',
            binary: 'C:/data/computer-use/0.39.0/cua_driver_sdk.dll',
            driverVersion: '0.39.0',
            installedSizeBytes: 33000000,
            error: null,
            installed: true,
        });
        expect(nativeCancelAll).toHaveBeenCalledTimes(1);
        expect(nativeInstallUpdate).toHaveBeenCalledWith('cua-driver', '0.39.0');
    });

    it('user removes the driver through the native command', async () => {
        nativeRemove.mockResolvedValue(true);

        await remove();

        expect(nativeRemove).toHaveBeenCalledTimes(1);
    });

    it('user sees behaviour settings forwarded to the driver', async () => {
        nativeApply.mockResolvedValue([]);

        await applySettings({ ...DEFAULT_SETTINGS, cursorVisible: false, maxImageDimension: 900 });

        expect(nativeCall).toHaveBeenCalledWith(
            expect.objectContaining({
                tool: 'set_config',
                arguments: { max_image_dimension: 900 },
                fullAccess: false,
            })
        );
        expect(nativeCall).toHaveBeenCalledWith(
            expect.objectContaining({
                tool: 'set_agent_cursor_enabled',
                arguments: { enabled: false },
                fullAccess: false,
            })
        );
    });

    it('user gets the computer-use glow triggered through the service', async () => {
        nativePulseGlow.mockResolvedValue(undefined);

        await pulseGlow();

        expect(nativePulseGlow).toHaveBeenCalledTimes(1);
    });

    it('user turning recording on reaches the driver', async () => {
        nativeRecording.mockResolvedValue(true);

        await setRecording(true);

        expect(nativeRecording).toHaveBeenCalledWith(
            true,
            'C:/cache/computer-use-trajectories/cua-driver'
        );
    });
});

describe('computer use recording location', () => {
    it('user given no location preference when checking then receives the app cache recording directory', async () => {
        await expect(loadRecordingDirectory()).resolves.toBe(
            'C:/cache/computer-use-trajectories/cua-driver'
        );
    });

    it('user given recording enabled when selecting a folder then records there and keeps that choice for the next start', async () => {
        await saveSettings({ recordingEnabled: true });
        await saveRecordingDirectory('C:/用户记录/电脑控制');
        expect(nativeRecording).toHaveBeenLastCalledWith(true, 'C:/用户记录/电脑控制/cua-driver');
        await expect(loadRecordingDirectory()).resolves.toBe('C:/用户记录/电脑控制/cua-driver');
        await setRecording(false);
        await setRecording(true);
        expect(nativeRecording).toHaveBeenLastCalledWith(true, 'C:/用户记录/电脑控制/cua-driver');
    });

    it('user given an unavailable folder when switching then retains the previous preference', async () => {
        await saveRecordingDirectory('C:/previous');
        await saveSettings({ recordingEnabled: true });
        nativeRecording.mockRejectedValueOnce(new Error('Access denied'));
        await expect(saveRecordingDirectory('C:/unwritable')).rejects.toThrow('Access denied');
        await expect(loadRecordingDirectory()).resolves.toBe('C:/previous/cua-driver');
    });

    it('user given settings storage fails when selecting a folder then retains the old location without changing the recorder', async () => {
        await saveRecordingDirectory('C:/previous');
        await saveSettings({ recordingEnabled: true });
        nativeRecording.mockClear();
        vi.mocked(setSetting).mockRejectedValueOnce(new Error('Storage full'));
        await expect(saveRecordingDirectory('C:/new')).rejects.toThrow('Storage full');
        await expect(loadRecordingDirectory()).resolves.toBe('C:/previous/cua-driver');
        expect(nativeRecording).not.toHaveBeenCalled();
    });
});

describe('computer use session approvals', () => {
    beforeEach(() => {
        clearSessionApprovals();
    });

    it('user gets a stable key per window', () => {
        expect(targetKey(12, 34)).toBe('12:34');
        expect(targetKey(12, 35)).not.toBe(targetKey(12, 34));
        expect(targetKey(12, 34)).toBe(targetKey(12, 34));
    });

    it('user allows one window without allowing every window', () => {
        allowForSession(targetKey(12, 34));

        expect(isAllowedForSession(targetKey(12, 34))).toBe(true);
        expect(isAllowedForSession(targetKey(12, 35))).toBe(false);
        expect(isAllowedForSession(targetKey(13, 34))).toBe(false);
    });

    it('user forgets every session grant when the session ends', () => {
        allowForSession(targetKey(12, 34));
        clearSessionApprovals();

        expect(isAllowedForSession(targetKey(12, 34))).toBe(false);
    });
});
