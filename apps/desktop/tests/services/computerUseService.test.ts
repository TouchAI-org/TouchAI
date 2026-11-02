import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStore = new Map<string, string>();
const statisticStore = new Map<string, string>();

vi.mock('@database/queries/settings', () => ({
    getSettingValue: vi.fn(async ({ key }: { key: string }) => settingsStore.get(key) ?? null),
    setSetting: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        settingsStore.set(key, value);
        return { key, value };
    }),
}));

vi.mock('@database/queries/statistics', () => ({
    getStatistic: vi.fn(async ({ key }: { key: string }) => statisticStore.get(key) ?? null),
    setStatistic: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        statisticStore.set(key, value);
        return true;
    }),
}));

const nativeStatus = vi.fn();
const nativeUpdate = vi.fn();
const nativeRemove = vi.fn();
const nativeApply = vi.fn();
const nativeRecording = vi.fn();

vi.mock('@services/NativeService', () => ({
    computerUse: {
        status: () => nativeStatus(),
        prepare: () => nativeStatus(),
        checkUpdate: () => nativeUpdate(),
        remove: () => nativeRemove(),
        applySettings: (request: unknown) => nativeApply(request),
        setRecording: (enabled: boolean) => nativeRecording(enabled),
        call: vi.fn(),
        cancel: vi.fn(),
        shutdown: vi.fn(),
    },
}));

const {
    DEFAULT_SETTINGS,
    EMPTY_STATS,
    allowForSession,
    applySettings,
    checkUpdate,
    clearSessionApprovals,
    isAllowedForSession,
    loadSettings,
    loadStats,
    prepare,
    recordAction,
    remove,
    saveSettings,
    setRecording,
    status,
    targetKey,
} = await import('@services/ComputerUseService');

beforeEach(() => {
    settingsStore.clear();
    statisticStore.clear();
    nativeStatus.mockReset();
    nativeUpdate.mockReset();
    nativeRemove.mockReset();
    nativeApply.mockReset();
    nativeRecording.mockReset();
});

describe('computer use settings', () => {
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

describe('computer use statistics', () => {
    it('user starts from empty counters', async () => {
        await expect(loadStats()).resolves.toEqual(EMPTY_STATS);
    });

    it('user sees a denied action counted without a success', async () => {
        await recordAction({ denied: true, succeeded: false, durationMs: 10 });

        const stats = await loadStats();
        expect(stats.actions).toBe(1);
        expect(stats.denied).toBe(1);
        expect(stats.successes).toBe(0);
        expect(stats.avgDurationMs).toBe(10);
    });

    it('user gets the running average of step durations', async () => {
        await recordAction({ succeeded: true, durationMs: 10 });
        await recordAction({ succeeded: true, durationMs: 30 });

        const stats = await loadStats();
        expect(stats.actions).toBe(2);
        expect(stats.successes).toBe(2);
        expect(stats.avgDurationMs).toBe(20);
    });

    it('user keeps the average when an action has no duration', async () => {
        await recordAction({ succeeded: true, durationMs: 40 });
        await recordAction({ succeeded: false });

        const stats = await loadStats();
        expect(stats.actions).toBe(2);
        expect(stats.durationSamples).toBe(1);
        expect(stats.avgDurationMs).toBe(40);
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

    it('user removes the driver through the native command', async () => {
        nativeRemove.mockResolvedValue(true);

        await remove();

        expect(nativeRemove).toHaveBeenCalledTimes(1);
    });

    it('user sees behaviour settings forwarded to the driver', async () => {
        nativeApply.mockResolvedValue([]);

        await applySettings({ ...DEFAULT_SETTINGS, cursorVisible: false, maxImageDimension: 900 });

        expect(nativeApply).toHaveBeenCalledWith({
            cursorVisible: false,
            maxImageDimension: 900,
        });
    });

    it('user turning recording on reaches the driver', async () => {
        nativeRecording.mockResolvedValue(true);

        await setRecording(true);

        expect(nativeRecording).toHaveBeenCalledWith(true);
    });
});

describe('computer use session approvals', () => {
    beforeEach(() => {
        clearSessionApprovals();
    });

    it('user gets a stable key per action and window', () => {
        expect(targetKey('click', 12, 34)).toBe('click:12:34');
        expect(targetKey('type', 12, 34)).not.toBe(targetKey('click', 12, 34));
        expect(targetKey('click', 12, 34)).toBe(targetKey('click', 12, 34));
    });

    it('user allows one window without allowing every window', () => {
        allowForSession(targetKey('click', 12, 34));

        expect(isAllowedForSession(targetKey('click', 12, 34))).toBe(true);
        expect(isAllowedForSession(targetKey('click', 12, 35))).toBe(false);
        expect(isAllowedForSession(targetKey('type', 12, 34))).toBe(false);
    });

    it('user forgets every session grant when the session ends', () => {
        allowForSession(targetKey('click', 12, 34));
        clearSessionApprovals();

        expect(isAllowedForSession(targetKey('click', 12, 34))).toBe(false);
    });
});
