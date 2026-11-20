import { getSettingValue, setSetting } from '@/database/queries/settings';

const REMINDER_HISTORY_KEY = 'app_update_reminder_history';
export function createUpdateReminderStorage() {
    return Object.freeze({
        load: () => getSettingValue({ key: REMINDER_HISTORY_KEY }),
        async save(value: string) {
            await setSetting({ key: REMINDER_HISTORY_KEY, value });
        },
    });
}
