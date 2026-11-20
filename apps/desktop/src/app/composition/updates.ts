import { createUpdateNotificationBody } from '@/app/api/updates/notificationText';
import { startAutomaticUpdateChecks } from '@/app/workflows/updates/automatic';
import { AppEvent, eventService } from '@/app/workflows/windows/events';
import { t } from '@/i18n';
import type { SettingsApi } from '@/modules/settings/public';
import {
    AppUpdateController,
    AppUpdateReminderController,
    createUpdateReminderStorage,
} from '@/modules/updates';
import { log } from '@/platform/diagnostics';
import { native } from '@/platform/native';
import { listenWindowEvent } from '@/platform/windows/events';
import { requireMainExecutionHost } from '@/platform/windows/execution';

import type { assembleAnalyticsWindow } from './analytics';

/** One controller and reminder history owner, using the same main preferences writer. */
export function assembleMainUpdates(input: {
    settings: SettingsApi;
    analytics: ReturnType<typeof assembleAnalyticsWindow>['updates'];
}) {
    requireMainExecutionHost();
    const settings = input.settings;
    async function commitPreference(
        key: Parameters<SettingsApi['mutate']>[0],
        value: Parameters<SettingsApi['mutate']>[1]
    ) {
        const result = await settings.mutate(key, value);
        if (result.status !== 'committed') throw new Error('UPDATES_UNCONFIRMED');
    }
    const controller = new AppUpdateController({
        native: native.updater,
        settings: {
            initialize: settings.initialize,
            getChannel: () => settings.getSnapshot().appUpdateChannel,
            getAutoCheckEnabled: () => settings.getSnapshot().appUpdateAutoCheck,
            getLastCheckedAt: () => settings.getSnapshot().appUpdateLastCheckedAt,
            async updateAppUpdateChannel(value) {
                await commitPreference('app_update_channel', value);
            },
            async updateAppUpdateAutoCheck(value) {
                await commitPreference('app_update_auto_check', value);
            },
            async updateAppUpdateLastCheckedAt(value) {
                await commitPreference('app_update_last_checked_at', value);
            },
        },
        analytics: input.analytics,
        progress: {
            listen: (listener) =>
                listenWindowEvent('main', 'updater://download-progress', (payload) => {
                    if (typeof payload === 'number' && Number.isFinite(payload)) listener(payload);
                }),
        },
        environment: {
            isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
            offlineMessage: () => t('settings.general.update.error.offline'),
        },
        diagnostics: log,
    });
    const reminders = new AppUpdateReminderController({
        updates: controller,
        storage: createUpdateReminderStorage(),
        notifications: {
            listen: (listener) =>
                eventService.on(AppEvent.APP_UPDATE_NOTIFICATION_ACTION, listener),
            show: native.updater.showUpdateNotification,
        },
        createPayload: (state, version) => ({
            channel: state.channel,
            version,
            title: t('notification.update.title', { version }),
            body: createUpdateNotificationBody(state),
            updateLabel: t('notification.update.viewDetails'),
            ignoreLabel: t('notification.update.ignoreVersion'),
        }),
        openSettings: native.updater.openUpdateSettings,
        diagnostics: log,
    });
    let stop: (() => void) | undefined;
    return Object.freeze({
        controller,
        startAutomaticChecks() {
            stop?.();
            stop = startAutomaticUpdateChecks(controller, () => reminders.initialize());
        },
        dispose() {
            stop?.();
            stop = undefined;
            reminders.dispose();
            return controller.dispose();
        },
    });
}
