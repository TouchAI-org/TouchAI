import { AppUpdateController } from '@services/AppUpdateService';
import { AppUpdateReminderController } from '@services/AppUpdateService/reminders';
import type { AppUpdateChannel, AppUpdateCheckResult } from '@services/AppUpdateService/types';
import { AppEvent, eventService } from '@services/EventService';
import { native } from '@services/NativeService';
import { emit } from '@tauri-apps/api/event';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { getTauriInvokeCalls, interceptTauriInvoke, mockTauriCommand } from '../../utils/tauri';

const checkedAt = '2026-11-10T10:00:00.000Z';
const available: AppUpdateCheckResult = {
    status: 'available',
    channel: 'stable',
    currentVersion: '1.2.2',
    latest: null,
    update: { version: '1.2.3', fileName: 'update.nupkg', notes: null, sizeBytes: null },
    requirement: {
        required: false,
        minimumSupportedVersion: null,
        requiredSeverity: null,
        requiredReason: null,
        targetSatisfiesRequirement: true,
    },
};

const updates: AppUpdateController[] = [];
const reminders: AppUpdateReminderController[] = [];

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

function registrations(event: string) {
    return getTauriInvokeCalls('plugin:event|listen').filter(
        (call) => (call.payload as { event?: string })?.event === event
    );
}

function deferRegistration(event: string, registerBeforeWaiting = false) {
    const started = deferred();
    const completion = deferred();
    let waiting = true;
    interceptTauriInvoke(async (call, next) => {
        if (
            waiting &&
            call.cmd === 'plugin:event|listen' &&
            (call.payload as { event?: string })?.event === event
        ) {
            waiting = false;
            const result = registerBeforeWaiting ? await next() : undefined;
            started.resolve();
            await completion.promise;
            return registerBeforeWaiting ? result : next();
        }
        return next();
    });
    return { started: started.promise, finish: completion.resolve };
}

async function broadcastAvailable() {
    await eventService.emit(AppEvent.APP_UPDATE_CHECKED, {
        sourceId: 'another-window',
        result: available,
        checkedAt,
    });
}

async function openNotification() {
    await eventService.emit(AppEvent.APP_UPDATE_NOTIFICATION_ACTION, {
        action: 'open',
        channel: 'stable',
        version: '1.2.3',
    });
    await flushPromises();
}

function createController(initializeSettings: () => Promise<void> = async () => {}) {
    let channel: AppUpdateChannel = 'stable';
    let autoCheckEnabled = true;
    let lastCheckedAt: string | null = null;
    const controller = new AppUpdateController({
        native: native.updater,
        settings: {
            initialize: initializeSettings,
            getChannel: () => channel,
            getAutoCheckEnabled: () => autoCheckEnabled,
            getLastCheckedAt: () => lastCheckedAt,
            updateAppUpdateChannel: async (value) => {
                channel = value;
            },
            updateAppUpdateAutoCheck: async (value) => {
                autoCheckEnabled = value;
            },
            updateAppUpdateLastCheckedAt: async (value) => {
                lastCheckedAt = value;
            },
        },
        checkEvents: {
            listen: (listener) =>
                eventService.on(AppEvent.APP_UPDATE_CHECKED, (event) => {
                    listener(event.result, event.checkedAt);
                }),
            publish: async (result, time) => {
                await eventService.emit(AppEvent.APP_UPDATE_CHECKED, {
                    sourceId: 'controller',
                    result,
                    checkedAt: time,
                });
            },
        },
        now: () => checkedAt,
    });
    updates.push(controller);
    return controller;
}

async function createReminder(load: () => Promise<string | null> = async () => null) {
    const controller = createController();
    await controller.initialize();
    const savedHistory: string[] = [];
    const reminder = new AppUpdateReminderController({
        updates: controller,
        storage: {
            load,
            save: async (value) => {
                savedHistory.push(value);
            },
        },
        notifications: {
            listen: (listener) =>
                eventService.on(AppEvent.APP_UPDATE_NOTIFICATION_ACTION, listener),
            show: native.updater.showUpdateNotification,
        },
        createPayload: (state, version) => ({
            channel: state.channel,
            version,
            title: 'Update',
            body: version,
            updateLabel: 'View details',
            ignoreLabel: 'Ignore this version',
        }),
        openSettings: native.updater.openUpdateSettings,
        now: () => new Date(2026, 10, 10, 10).getTime(),
    });
    reminders.push(reminder);
    return { reminder, savedHistory };
}

afterEach(async () => {
    for (const reminder of reminders.splice(0)) reminder.dispose();
    for (const controller of updates.splice(0)) await controller.dispose();
    await flushPromises();
});

describe('user initializes and disposes update listeners', () => {
    it('user initializes updates concurrently and receives one shared subscription', async () => {
        const controller = createController();

        await Promise.all([controller.initialize(), controller.initialize()]);
        await broadcastAvailable();

        expect(controller.getState().status).toBe('available');
        expect(registrations(AppEvent.APP_UPDATE_CHECKED)).toHaveLength(1);
    });

    it('user disposes updates during settings loading and no native subscription starts later', async () => {
        const storage = deferred();
        const controller = createController(() => storage.promise);
        const initialization = controller.initialize();

        await controller.dispose();
        storage.resolve();
        await initialization;
        await broadcastAvailable();

        expect(controller.getState().status).toBe('idle');
        expect(registrations(AppEvent.APP_UPDATE_CHECKED)).toEqual([]);
    });

    it('user disposes updates during registration and late check events cannot change its state', async () => {
        const registration = deferRegistration(AppEvent.APP_UPDATE_CHECKED);
        const controller = createController();
        const initialization = controller.initialize();
        await registration.started;

        await controller.dispose();
        registration.finish();
        await initialization;
        await broadcastAvailable();

        expect(controller.getState().status).toBe('idle');
    });

    it('user reinitializes updates without waiting for a disposed registration', async () => {
        const registration = deferRegistration(AppEvent.APP_UPDATE_CHECKED);
        const controller = createController();
        const previous = controller.initialize();
        await registration.started;
        await controller.dispose();

        const current = controller.initialize();
        await flushPromises();
        await broadcastAvailable();
        const stateBeforePreviousCompletion = controller.getState();
        registration.finish();
        await Promise.all([previous, current]);

        expect(stateBeforePreviousCompletion.status).toBe('available');
        await broadcastAvailable();
        expect(controller.getState().status).toBe('available');
    });

    it('user receives download progress once when a disposed subscription returns after reinitialization', async () => {
        const registration = deferRegistration('updater://download-progress', true);
        const controller = createController();
        const previous = controller.initialize();
        await registration.started;
        await controller.dispose();
        await controller.initialize();
        await broadcastAvailable();

        const downloadStarted = deferred();
        const downloadFinished = deferred();
        mockTauriCommand('updater_download_update', async () => {
            downloadStarted.resolve();
            await downloadFinished.promise;
            return available.update;
        });
        const progress: number[] = [];
        const unsubscribe = controller.subscribe((state) => {
            if (state.status === 'downloading' && state.downloadProgress !== null) {
                progress.push(state.downloadProgress);
            }
        });
        const downloading = controller.download();

        try {
            await downloadStarted.promise;
            await emit('updater://download-progress', 75);
            expect(progress).toEqual([0, 75]);

            registration.finish();
            await previous;
            await emit('updater://download-progress', 80);
            expect(progress).toEqual([0, 75, 80]);
        } finally {
            registration.finish();
            downloadFinished.resolve();
            await previous;
            await downloading;
            unsubscribe();
        }
    });

    it('user retries a failed settings load and receives update results after recovery', async () => {
        let fail = true;
        const controller = createController(async () => {
            if (fail) throw new Error('settings unavailable');
        });

        await expect(controller.initialize()).rejects.toThrow('settings unavailable');
        fail = false;
        await controller.initialize();
        await broadcastAvailable();

        expect(controller.getState().status).toBe('available');
    });
});

describe('user initializes and disposes update reminders', () => {
    it('user initializes reminders concurrently and disposal leaves no duplicate notification listener', async () => {
        const { reminder } = await createReminder();
        await Promise.all([reminder.initialize(), reminder.initialize()]);

        reminder.dispose();
        await openNotification();

        expect(getTauriInvokeCalls('updater_open_update_settings')).toEqual([]);
        expect(registrations(AppEvent.APP_UPDATE_NOTIFICATION_ACTION)).toHaveLength(1);
    });

    it('user disposes reminders during history loading and no notification registration starts later', async () => {
        const storage = deferred();
        const { reminder, savedHistory } = await createReminder(async () => {
            await storage.promise;
            return null;
        });
        const initialization = reminder.initialize();

        reminder.dispose();
        storage.resolve();
        await initialization;
        await openNotification();

        expect(registrations(AppEvent.APP_UPDATE_NOTIFICATION_ACTION)).toEqual([]);
        expect(getTauriInvokeCalls('updater_open_update_settings')).toEqual([]);
        expect(savedHistory).toEqual([]);
    });

    it('user disposes a registering reminder and queued native actions cannot open settings', async () => {
        const { reminder } = await createReminder();
        const registration = deferRegistration(AppEvent.APP_UPDATE_NOTIFICATION_ACTION, true);
        const initialization = reminder.initialize();
        await registration.started;

        reminder.dispose();
        await openNotification();
        registration.finish();
        await initialization;

        expect(getTauriInvokeCalls('updater_open_update_settings')).toEqual([]);
    });

    it('user retries failed reminder registration and the next notification opens settings', async () => {
        const { reminder } = await createReminder();
        let fail = true;
        interceptTauriInvoke((call, next) => {
            if (
                call.cmd === 'plugin:event|listen' &&
                (call.payload as { event?: string })?.event ===
                    AppEvent.APP_UPDATE_NOTIFICATION_ACTION &&
                fail
            ) {
                throw new Error('notifications unavailable');
            }
            return next();
        });

        await expect(reminder.initialize()).rejects.toThrow('notifications unavailable');
        fail = false;
        await reminder.initialize();
        await openNotification();

        expect(getTauriInvokeCalls('updater_open_update_settings')).toHaveLength(1);
    });

    it('user disposes reminders repeatedly and its native subscription is released once', async () => {
        const { reminder } = await createReminder();
        await reminder.initialize();

        reminder.dispose();
        reminder.dispose();

        const releases = getTauriInvokeCalls('plugin:event|unlisten').filter(
            (call) =>
                (call.payload as { event?: string })?.event ===
                AppEvent.APP_UPDATE_NOTIFICATION_ACTION
        );
        expect(releases).toHaveLength(1);
    });
});
