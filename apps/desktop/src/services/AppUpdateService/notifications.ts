import { getSettingValue, setSetting } from '@database/queries';
import { AppEvent, eventService } from '@services/EventService';
import { native } from '@services/NativeService';

import { t } from '@/i18n';

import { appUpdateService } from './index';
import { createUpdateNotificationBody } from './notificationText';
import { AppUpdateReminderController } from './reminders';

const REMINDER_HISTORY_KEY = 'app_update_reminder_history';

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
        updateLabel: t('notification.update.viewDetails'),
        ignoreLabel: t('notification.update.ignoreVersion'),
    }),
    openSettings: () => native.updater.openUpdateSettings(),
});

export function initializeAppUpdateNotifications(): Promise<void> {
    return updateReminders.initialize();
}
