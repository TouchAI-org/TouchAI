import {
    activeNotificationElapsedMs,
    AppUpdateReminderController,
} from '@services/AppUpdateService/reminders';
import { createInitialAppUpdateState } from '@services/AppUpdateService/state';
import type { AppUpdateState } from '@services/AppUpdateService/types';
import type { AppUpdateNotificationAction } from '@services/NativeService/types';
import { describe, expect, it, vi } from 'vitest';

const HOUR = 60 * 60 * 1000;

function localTime(day: number, hour: number, minute = 0): number {
    return new Date(2026, 9, day, hour, minute).getTime();
}

function createReminder(options: { raw?: string | null; now?: number } = {}) {
    let state: AppUpdateState = {
        ...createInitialAppUpdateState(),
        status: 'available',
        currentVersion: '1.2.2',
        availableUpdate: {
            version: '1.2.3',
            fileName: 'update.nupkg',
            notes: null,
            sizeBytes: null,
        },
    };
    let now = options.now ?? localTime(18, 10);
    let raw = options.raw ?? null;
    let onState: (state: AppUpdateState) => void = () => {};
    let onAction: (action: AppUpdateNotificationAction) => void = () => {};
    const unsubscribe = vi.fn();
    const unlisten = vi.fn();
    const show = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn(async (value: string) => {
        raw = value;
    });
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const controller = new AppUpdateReminderController({
        updates: {
            getState: () => state,
            subscribe: (listener) => {
                onState = listener;
                listener(state);
                return unsubscribe;
            },
        },
        storage: { load: async () => raw, save },
        notifications: {
            listen: async (listener) => {
                onAction = listener;
                return unlisten;
            },
            show,
        },
        createPayload: (snapshot, version) => ({
            channel: snapshot.channel,
            version,
            title: 'Update',
            body: version,
            updateLabel: 'View details',
            ignoreLabel: 'Ignore this version',
        }),
        openSettings,
        now: () => now,
    });
    return {
        controller,
        show,
        save,
        openSettings,
        unsubscribe,
        unlisten,
        getRaw: () => raw,
        advance: (hours: number) => {
            now += hours * HOUR;
        },
        change: (patch: Partial<AppUpdateState> = {}) => {
            state = { ...state, ...patch };
            onState(state);
        },
        action: (
            action: AppUpdateNotificationAction['action'],
            channel: AppUpdateNotificationAction['channel'] = 'stable',
            version = '1.2.3'
        ) => onAction({ action, channel, version }),
    };
}

async function flushReminder() {
    for (let index = 0; index < 15; index += 1) await Promise.resolve();
}

describe('AppUpdateReminderController', () => {
    it('counts real elapsed time across the notification quiet hours', () => {
        const start = localTime(18, 23);
        const quietEnd = localTime(19, 8);
        const fiveActiveHours = localTime(19, 12);

        expect(activeNotificationElapsedMs(start, quietEnd)).toBe(9 * HOUR);
        expect(activeNotificationElapsedMs(start, fiveActiveHours)).toBe(13 * HOUR);
        expect(activeNotificationElapsedMs(localTime(18, 0), localTime(18, 8))).toBe(8 * HOUR);
        expect(activeNotificationElapsedMs(localTime(18, 0), localTime(20, 8))).toBe(56 * HOUR);
    });

    it('waits for an update result at 08:00 instead of notifying during quiet hours', async () => {
        const reminder = createReminder({ now: localTime(18, 7, 30) });
        await reminder.controller.initialize();
        await flushReminder();
        expect(reminder.show).not.toHaveBeenCalled();
        expect(reminder.save).not.toHaveBeenCalled();

        reminder.advance(0.5);
        reminder.change();
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledTimes(1);
    });

    it('sends an actionable OS notification and waits five hours before reminding again', async () => {
        const reminder = createReminder();
        await reminder.controller.initialize();
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledWith(
            expect.objectContaining({
                version: '1.2.3',
                updateLabel: 'View details',
                ignoreLabel: 'Ignore this version',
            })
        );

        reminder.advance(4);
        reminder.change();
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledTimes(1);

        reminder.advance(1);
        reminder.change();
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledTimes(2);
    });

    it('keeps the five-hour deadline across midnight and application restarts', async () => {
        const reminder = createReminder({ now: localTime(18, 23) });
        await reminder.controller.initialize();
        await flushReminder();
        reminder.controller.dispose();

        const reopened = createReminder({
            raw: reminder.getRaw(),
            now: localTime(19, 0),
        });
        await reopened.controller.initialize();
        await flushReminder();
        expect(reopened.show).not.toHaveBeenCalled();

        reopened.advance(4);
        reopened.change();
        await flushReminder();
        expect(reopened.show).not.toHaveBeenCalled();

        reopened.advance(4);
        reopened.change();
        await flushReminder();
        expect(reopened.show).toHaveBeenCalledTimes(1);
    });

    it('persists ignoring a version while allowing a later version to notify', async () => {
        const reminder = createReminder();
        await reminder.controller.initialize();
        await flushReminder();
        reminder.action('ignore');
        await flushReminder();
        reminder.controller.dispose();

        const reopened = createReminder({
            raw: reminder.getRaw(),
            now: localTime(21, 10),
        });
        await reopened.controller.initialize();
        await flushReminder();
        expect(reopened.show).not.toHaveBeenCalled();
        reopened.change();
        await flushReminder();
        expect(reopened.show).not.toHaveBeenCalled();

        reopened.change({
            availableUpdate: {
                version: '1.2.4',
                fileName: 'update.nupkg',
                notes: null,
                sizeBytes: null,
            },
        });
        await flushReminder();
        expect(reopened.show).toHaveBeenCalledWith(expect.objectContaining({ version: '1.2.4' }));
    });

    it('keeps ignored and notification deadlines separate for the same version in each channel', async () => {
        const reminder = createReminder();
        await reminder.controller.initialize();
        await flushReminder();
        reminder.action('ignore');
        await flushReminder();

        reminder.change({ channel: 'beta' });
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledTimes(2);
        expect(reminder.show).toHaveBeenLastCalledWith(
            expect.objectContaining({ channel: 'beta', version: '1.2.3' })
        );

        reminder.action('ignore', 'stable');
        await flushReminder();
        reminder.advance(5);
        reminder.change();
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledTimes(3);
    });

    it('opens current update details from stale notifications without ignoring another update', async () => {
        const reminder = createReminder();
        await reminder.controller.initialize();
        await flushReminder();
        reminder.change({ channel: 'beta' });
        await flushReminder();
        reminder.action('update', 'stable');
        reminder.action('open', 'stable');
        reminder.action('ignore', 'stable');
        await flushReminder();

        reminder.change({
            channel: 'stable',
            availableUpdate: {
                version: '1.2.4',
                fileName: 'update.nupkg',
                notes: null,
                sizeBytes: null,
            },
        });
        reminder.action('update', 'stable', '1.2.3');
        reminder.action('ignore', 'stable', '1.2.3');
        await flushReminder();
        expect(reminder.openSettings).toHaveBeenCalledTimes(2);
        expect(JSON.parse(reminder.getRaw()!)['stable:1.2.3']?.ignored).not.toBe(true);
    });

    it('opens update settings even while a fresh update check is running', async () => {
        const reminder = createReminder();
        await reminder.controller.initialize();
        await flushReminder();
        reminder.change({ status: 'checking' });

        reminder.action('update');
        await flushReminder();

        expect(reminder.openSettings).toHaveBeenCalledTimes(1);
    });

    it('accepts a matching notification after the update has already downloaded', async () => {
        const reminder = createReminder();
        await reminder.controller.initialize();
        await flushReminder();
        reminder.change({
            status: 'downloaded',
            availableUpdate: null,
            downloadedUpdate: {
                version: '1.2.3',
                fileName: 'update.nupkg',
                notes: null,
                sizeBytes: null,
            },
        });
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledTimes(1);

        reminder.action('update');
        await flushReminder();
        expect(reminder.openSettings).toHaveBeenCalledTimes(1);

        reminder.action('open');
        await flushReminder();
        expect(reminder.openSettings).toHaveBeenCalledTimes(2);

        reminder.action('ignore');
        await flushReminder();
        expect(JSON.parse(reminder.getRaw()!)['stable:1.2.3']?.ignored).toBe(true);
    });

    it('does not repeat a notification for progress, failed checks, or concurrent state changes', async () => {
        const reminder = createReminder();
        await reminder.controller.initialize();
        reminder.change();
        reminder.change();
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledTimes(1);

        reminder.advance(6);
        reminder.change({ status: 'checking' });
        reminder.change({ status: 'failed' });
        reminder.change({ status: 'downloading' });
        await flushReminder();
        expect(reminder.show).toHaveBeenCalledTimes(1);
    });

    it('does not persist the notification deadline if OS delivery fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const reminder = createReminder();
        reminder.show.mockRejectedValueOnce(new Error('notifications disabled'));
        try {
            await reminder.controller.initialize();
            await flushReminder();
            expect(reminder.save).not.toHaveBeenCalled();
            reminder.change();
            await flushReminder();
            expect(reminder.show).toHaveBeenCalledTimes(2);
            expect(reminder.save).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });

    it.each(['idle', 'not_available', 'checking', 'failed', 'downloaded'] as const)(
        'does not notify in %s state',
        async (status) => {
            const reminder = createReminder();
            reminder.change({ status });
            await reminder.controller.initialize();
            await flushReminder();
            expect(reminder.show).not.toHaveBeenCalled();
        }
    );

    it('respects disabled automatic reminders and receives native button actions only once', async () => {
        const reminder = createReminder();
        reminder.change({ autoCheckEnabled: false });
        await reminder.controller.initialize();
        await flushReminder();
        expect(reminder.show).not.toHaveBeenCalled();

        reminder.action('update');
        reminder.action('update');
        await flushReminder();
        expect(reminder.openSettings).toHaveBeenCalledTimes(1);
        reminder.action('open');
        await flushReminder();
        expect(reminder.openSettings).toHaveBeenCalledTimes(2);
        reminder.controller.dispose();
        expect(reminder.unsubscribe).toHaveBeenCalledTimes(1);
        expect(reminder.unlisten).toHaveBeenCalledTimes(1);
    });
});
