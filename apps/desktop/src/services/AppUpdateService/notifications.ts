import { getSettingValue, setSetting } from '@database/queries';
import { AppEvent, eventService } from '@services/EventService';
import { native } from '@services/NativeService';
import type { AppUpdateNotificationAction } from '@services/NativeService/types';
import { openUrl } from '@tauri-apps/plugin-opener';

import { APP_PRODUCT_CONFIG } from '@/config/product';
import { t } from '@/i18n';

import { getAvailableAppUpdateVersion } from './availability';
import { preferredAppUpdateDownload } from './downloads';
import { appUpdateService } from './index';
import { createUpdateNotificationBody } from './notificationText';
import { AppUpdateReminderController } from './reminders';

const REMINDER_HISTORY_KEY = 'app_update_reminder_history';

async function updateFromNotification(action: AppUpdateNotificationAction): Promise<void> {
    // Recheck before acting on a notification that may have been sitting in the OS history.
    const previous = appUpdateService.getState();
    if (previous.channel !== action.channel) {
        await native.updater.openUpdateSettings();
        return;
    }
    if (previous.status !== 'downloaded' && !(await appUpdateService.checkNow('manual'))) {
        await native.updater.openUpdateSettings();
        return;
    }
    const state = appUpdateService.getState();
    if (
        state.updateRequirement?.targetSatisfiesRequirement === false ||
        state.channel !== action.channel ||
        getAvailableAppUpdateVersion(state)?.replace(/^v/, '') !== action.version.replace(/^v/, '')
    ) {
        await native.updater.openUpdateSettings();
        return;
    }

    if (state.status === 'unsupported') {
        const latest = state.latestUpdate;
        await openUrl(
            preferredAppUpdateDownload(latest?.downloads ?? [])?.url ??
                latest?.releaseUrl ??
                APP_PRODUCT_CONFIG.repository.releasesUrl
        );
        return;
    }

    if (
        state.status === 'downloaded' ||
        (state.status === 'available' && (await appUpdateService.download()))
    ) {
        if (await appUpdateService.install()) return;
    }

    await native.updater.openUpdateSettings();
}

const updateReminders = new AppUpdateReminderController({
    updates: appUpdateService,
    storage: {
        load: () => getSettingValue({ key: REMINDER_HISTORY_KEY }),
        save: async (value) => {
            await setSetting({ key: REMINDER_HISTORY_KEY, value });
        },
    },
    notifications: {
        listen: (listener) => eventService.on(AppEvent.APP_UPDATE_NOTIFICATION_ACTION, listener),
        show: (payload) => native.updater.showUpdateNotification(payload),
    },
    createPayload: (state, version) => ({
        channel: state.channel,
        version,
        title: t('notification.update.title', { version }),
        body: createUpdateNotificationBody(state),
        updateLabel: t('notification.update.updateNow'),
        ignoreLabel: t('notification.update.ignoreVersion'),
    }),
    update: updateFromNotification,
    openSettings: () => native.updater.openUpdateSettings(),
});

export function initializeAppUpdateNotifications(): Promise<void> {
    return updateReminders.initialize();
}
