import { createTestUpdateController } from '@tests/utils/updates';
import { describe, expect, it, vi } from 'vitest';

import type {
    AppUpdateChannel,
    AppUpdateCheckResult,
    AppUpdateInfo,
} from '@/modules/updates/types';

// The automatic-check window reads the local hour, so a fixed UTC instant must
// stay inside it on every developer machine.
process.env.TZ = 'UTC';

const availableUpdate: AppUpdateInfo = {
    version: '0.2.0',
    fileName: 'TouchAI-0.2.0-full.nupkg',
    notes: 'Bug fixes',
    sizeBytes: 12_000_000,
};

const neutralRequirement = {
    required: false,
    minimumSupportedVersion: null,
    requiredSeverity: null,
    requiredReason: null,
    targetSatisfiesRequirement: true,
};

function notAvailable(channel: AppUpdateChannel): AppUpdateCheckResult {
    return {
        status: 'not_available',
        channel,
        currentVersion: '0.1.0',
        latest: null,
        requirement: neutralRequirement,
    };
}

function available(channel: AppUpdateChannel): AppUpdateCheckResult {
    return {
        status: 'available',
        channel,
        currentVersion: '0.1.0',
        latest: null,
        update: availableUpdate,
        requirement: neutralRequirement,
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFixture() {
    let channel: AppUpdateChannel = 'stable';
    let autoCheckEnabled = true;
    let storedLastCheckedAt: string | null = null;
    let clock = Date.parse('2026-11-10T10:00:00.000Z');
    let savesPaused = false;
    let channelSavesPaused = false;
    let timestampSaveError: Error | null = null;
    let channelSaveError: Error | null = null;
    const pendingSaves: Array<{ value: string | null; land: () => void }> = [];
    const pendingChannelSaves: Array<{ land: () => void }> = [];

    const checkForUpdates = vi.fn((value: AppUpdateChannel) =>
        Promise.resolve(notAvailable(value))
    );

    const controller = createTestUpdateController({
        native: {
            checkForUpdates,
            downloadUpdate: vi.fn(),
            installUpdate: vi.fn(),
        },
        settings: {
            initialize: async () => {},
            getChannel: () => channel,
            getAutoCheckEnabled: () => autoCheckEnabled,
            getLastCheckedAt: () => storedLastCheckedAt,
            updateAppUpdateChannel: (value) => {
                if (channelSaveError) {
                    return Promise.reject(channelSaveError);
                }
                if (!channelSavesPaused) {
                    channel = value;
                    return Promise.resolve();
                }

                const write = deferred<void>();
                pendingChannelSaves.push({ land: () => write.resolve() });
                return write.promise.then(() => {
                    channel = value;
                });
            },
            updateAppUpdateAutoCheck: async (value) => {
                autoCheckEnabled = value;
            },
            updateAppUpdateLastCheckedAt: (value) => {
                if (timestampSaveError) {
                    return Promise.reject(timestampSaveError);
                }
                if (!savesPaused) {
                    storedLastCheckedAt = value;
                    return Promise.resolve();
                }

                const write = deferred<void>();
                pendingSaves.push({ value, land: () => write.resolve() });
                return write.promise.then(() => {
                    storedLastCheckedAt = value;
                });
            },
        },
        now: () => new Date(clock).toISOString(),
    });

    return {
        controller,
        checkForUpdates,
        holdSaves() {
            savesPaused = true;
        },
        /** The channel save stays in the database until the test lands it. */
        holdChannelWrites() {
            channelSavesPaused = true;
        },
        failChannelWrites(message: string) {
            channelSaveError = new Error(message);
        },
        failTimestampWrites(message: string) {
            timestampSaveError = new Error(message);
        },
        pendingTimestampWrites: () => pendingSaves.length,
        async landChannelWrites() {
            channelSavesPaused = false;
            for (let attempt = 0; attempt < 8; attempt++) {
                const write = pendingChannelSaves.shift();
                if (!write) return;
                write.land();
                await flush();
            }
        },
        /** The saved channel changes without this controller, for example from another window. */
        setSavedChannel(value: AppUpdateChannel) {
            channel = value;
        },
        /** A saved preference changes without this controller, for example from another window. */
        setSavedAutoCheck(value: boolean) {
            autoCheckEnabled = value;
        },
        advance(milliseconds: number) {
            clock += milliseconds;
        },
        storedLastCheckedAt: () => storedLastCheckedAt,
        /** Settles held settings writes so the most recent call lands last. */
        async settleWritesNewestFirst() {
            for (let attempt = 0; attempt < 8; attempt++) {
                const write = pendingSaves.pop();
                if (!write) return;
                write.land();
                await flush();
            }
        },
    };
}

describe('given update checks that are no longer the current decision', () => {
    it('user keeps the newly chosen channel when the old check saves its time after the switch', async () => {
        const {
            controller,
            checkForUpdates,
            holdSaves,
            storedLastCheckedAt,
            settleWritesNewestFirst,
            pendingTimestampWrites,
        } = createFixture();
        holdSaves();
        const oldCheck = deferred<AppUpdateCheckResult>();
        checkForUpdates.mockReturnValueOnce(oldCheck.promise);

        const checking = controller.checkNow('manual');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));

        // The old channel's check returns while it is still the current one,
        // so its checked time is queued for saving.
        oldCheck.resolve(available('stable'));
        await vi.waitFor(() => expect(pendingTimestampWrites()).toBe(1));

        // The user switches channel while that save is still in the database.
        const switching = controller.setChannel('beta');
        await flush();
        await settleWritesNewestFirst();
        await switching;

        expect(storedLastCheckedAt()).toBeNull();
        expect(controller.getState()).toMatchObject({
            status: 'idle',
            channel: 'beta',
            lastCheckedAt: null,
            availableUpdate: null,
        });
        await expect(checking).resolves.toBe(false);
    });

    it('user keeps the chosen channel state when an old check fails after switching away and back', async () => {
        const { controller, checkForUpdates, advance } = createFixture();
        checkForUpdates.mockResolvedValueOnce(available('stable'));
        await expect(controller.checkNow('manual')).resolves.toBe(true);
        expect(controller.getState()).toMatchObject({
            status: 'available',
            lastCheckedAt: '2026-11-10T10:00:00.000Z',
        });

        advance(60 * 60_000);
        const oldCheck = deferred<AppUpdateCheckResult>();
        checkForUpdates.mockReturnValueOnce(oldCheck.promise);
        const automatic = controller.checkNow('automatic');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2));

        await controller.setChannel('beta');
        await controller.setChannel('stable');
        oldCheck.reject(new Error('network unavailable'));
        await expect(automatic).resolves.toBe(false);

        expect(controller.getState()).toMatchObject({
            status: 'idle',
            channel: 'stable',
            lastCheckedAt: null,
            availableUpdate: null,
            error: null,
        });
    });

    it('user keeps the newer result when two checks for the channel finish out of order', async () => {
        const { controller, checkForUpdates, advance, storedLastCheckedAt } = createFixture();
        const oldCheck = deferred<AppUpdateCheckResult>();
        checkForUpdates.mockReturnValueOnce(oldCheck.promise);
        const oldChecking = controller.checkNow('manual');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));

        await controller.setChannel('beta');
        await controller.setChannel('stable');
        advance(2 * 60 * 60_000);
        const newChecking = controller.checkNow('manual');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2));
        await expect(newChecking).resolves.toBe(true);

        advance(30 * 60_000);
        oldCheck.resolve(available('stable'));
        await expect(oldChecking).resolves.toBe(false);

        expect(controller.getState()).toMatchObject({
            status: 'not_available',
            channel: 'stable',
            availableUpdate: null,
            lastCheckedAt: '2026-11-10T12:00:00.000Z',
        });
        expect(storedLastCheckedAt()).toBe('2026-11-10T12:00:00.000Z');
    });

    it('user keeps the channel saved elsewhere when the old check returns later', async () => {
        const { controller, checkForUpdates, setSavedChannel } = createFixture();
        const oldCheck = deferred<AppUpdateCheckResult>();
        checkForUpdates.mockReturnValueOnce(oldCheck.promise);
        const oldChecking = controller.checkNow('manual');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));

        setSavedChannel('beta');
        const newChecking = controller.checkNow('automatic');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2));
        expect(checkForUpdates).toHaveBeenNthCalledWith(2, 'beta');
        await expect(newChecking).resolves.toBe(true);

        oldCheck.resolve(available('stable'));
        await expect(oldChecking).resolves.toBe(false);
        expect(controller.getState()).toMatchObject({
            channel: 'beta',
            status: 'not_available',
            availableUpdate: null,
        });
    });

    it('user gets a fresh check after returning to the channel while the old check is still running', async () => {
        const { controller, checkForUpdates } = createFixture();
        const oldCheck = deferred<AppUpdateCheckResult>();
        checkForUpdates.mockReturnValueOnce(oldCheck.promise);
        const oldChecking = controller.checkNow('manual');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));

        await controller.setChannel('beta');
        await controller.setChannel('stable');
        const newChecking = controller.checkNow('manual');

        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2));
        oldCheck.resolve(notAvailable('stable'));

        await expect(Promise.all([oldChecking, newChecking])).resolves.toEqual([false, true]);
        expect(controller.getState()).toMatchObject({ status: 'not_available' });
    });
});

describe('given a channel switch that is still saving', () => {
    it('user gets the chosen channel checked when checking while the switch is still saving', async () => {
        const {
            controller,
            checkForUpdates,
            holdChannelWrites,
            landChannelWrites,
            storedLastCheckedAt,
        } = createFixture();
        holdChannelWrites();
        const switching = controller.setChannel('beta');
        await flush();

        const checking = controller.checkNow('manual');
        await flush();
        expect(checkForUpdates).not.toHaveBeenCalled();

        await landChannelWrites();
        await switching;
        await expect(checking).resolves.toBe(true);

        expect(checkForUpdates).toHaveBeenCalledTimes(1);
        expect(checkForUpdates).toHaveBeenCalledWith('beta');
        expect(controller.getState()).toMatchObject({
            channel: 'beta',
            status: 'not_available',
            lastCheckedAt: '2026-11-10T10:00:00.000Z',
        });
        expect(storedLastCheckedAt()).toBe('2026-11-10T10:00:00.000Z');
    });

    it('user gets the chosen channel checked when the check arrives before the switch has saved', async () => {
        const { controller, checkForUpdates, holdChannelWrites, landChannelWrites } =
            createFixture();
        holdChannelWrites();
        const switching = controller.setChannel('beta');
        // The settings window asks for a check in the same turn, before the
        // switch has reached its saves.
        const checking = controller.checkNow('manual');

        await flush();
        expect(checkForUpdates).not.toHaveBeenCalled();

        await landChannelWrites();
        await switching;
        await expect(checking).resolves.toBe(true);

        expect(checkForUpdates).toHaveBeenCalledTimes(1);
        expect(checkForUpdates).toHaveBeenCalledWith('beta');
        expect(controller.getState()).toMatchObject({
            channel: 'beta',
            status: 'not_available',
            lastCheckedAt: '2026-11-10T10:00:00.000Z',
        });
    });

    it('user gets the saved channel checked when a check was requested before the switch landed', async () => {
        const { controller, checkForUpdates, holdChannelWrites, landChannelWrites } =
            createFixture();
        const check = deferred<AppUpdateCheckResult>();
        checkForUpdates.mockImplementation(() => check.promise);
        holdChannelWrites();
        const switching = controller.setChannel('beta');
        await flush();
        const firstChecking = controller.checkNow('manual');
        await flush();

        await landChannelWrites();
        await switching;
        const secondChecking = controller.checkNow('manual');
        await flush();
        check.resolve(notAvailable('beta'));

        await expect(Promise.all([firstChecking, secondChecking])).resolves.toEqual([true, true]);
        expect(checkForUpdates.mock.calls.map((call) => call[0])).toEqual(['beta']);
        expect(controller.getState()).toMatchObject({
            channel: 'beta',
            status: 'not_available',
        });
    });

    it('user is not left stuck checking when the channel save fails and the channel stays the same', async () => {
        const { controller, checkForUpdates, failChannelWrites } = createFixture();
        const running = deferred<AppUpdateCheckResult>();
        checkForUpdates.mockReturnValueOnce(running.promise);

        const checking = controller.checkNow('manual');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
        expect(controller.getState().status).toBe('checking');

        failChannelWrites('channel save failed');
        await expect(controller.setChannel('beta')).rejects.toThrow('channel save failed');

        expect(controller.getState()).toMatchObject({ status: 'idle', channel: 'stable' });

        running.resolve(notAvailable('stable'));
        await expect(checking).resolves.toBe(false);
        expect(controller.getState().status).toBe('idle');
    });

    it('user checks the channel a settings listener switches to during the same request', async () => {
        const { controller, checkForUpdates, setSavedAutoCheck } = createFixture();
        await controller.initialize();

        let switched = false;
        controller.subscribe((state) => {
            if (switched || state.autoCheckEnabled) return;
            switched = true;
            void controller.setChannel('beta');
        });
        // The settings sync inside the check request sees this change and
        // notifies the listener, which starts the switch in the same turn.
        setSavedAutoCheck(false);

        await expect(controller.checkNow('manual')).resolves.toBe(true);

        expect(checkForUpdates.mock.calls.map(([value]) => value)).toEqual(['beta']);
        expect(controller.getState()).toMatchObject({ channel: 'beta' });
    });
});

describe('given the current update check', () => {
    it('user sees the completed check update the state and the saved checked time', async () => {
        const { controller, checkForUpdates, storedLastCheckedAt } = createFixture();
        checkForUpdates.mockResolvedValueOnce(available('stable'));

        await expect(controller.checkNow('manual')).resolves.toBe(true);

        expect(controller.getState()).toMatchObject({
            status: 'available',
            channel: 'stable',
            availableUpdate,
            lastCheckedAt: '2026-11-10T10:00:00.000Z',
            error: null,
        });
        expect(storedLastCheckedAt()).toBe('2026-11-10T10:00:00.000Z');
    });

    it('user gets the chosen channel checked right after switching without an old time delaying it', async () => {
        const { controller, checkForUpdates, advance, storedLastCheckedAt } = createFixture();

        // A completed check leaves a saved time behind; switching must clear it
        // or the automatic interval keeps the new channel from being checked.
        await expect(controller.checkNow('manual')).resolves.toBe(true);
        expect(storedLastCheckedAt()).toBe('2026-11-10T10:00:00.000Z');
        advance(10 * 60_000);

        await controller.setChannel('beta');
        expect(storedLastCheckedAt()).toBeNull();

        await expect(controller.checkNow('automatic')).resolves.toBe(true);
        expect(checkForUpdates).toHaveBeenCalledWith('beta');
        expect(controller.getState()).toMatchObject({
            status: 'not_available',
            channel: 'beta',
            lastCheckedAt: '2026-11-10T10:10:00.000Z',
        });
    });

    it('user keeps the previous status when the checked time cannot be saved', async () => {
        const { controller, failTimestampWrites } = createFixture();
        failTimestampWrites('checked time save failed');

        await expect(controller.checkNow('automatic')).resolves.toBe(false);

        expect(controller.getState()).toMatchObject({
            status: 'idle',
            error: null,
            lastCheckedAt: null,
        });
    });
});
