import { t } from '@/i18n';
import type { AppUpdateAnalytics } from '@/modules/updates';
import { AppUpdateController, AppUpdateReminderController } from '@/modules/updates';
import { log } from '@/platform/diagnostics';
import { listenWindowEvent } from '@/platform/windows/events';

import { createTestAnalyticsWindow } from './analyticsWindow';

export function createTestUpdateController(
    input: Omit<
        ConstructorParameters<typeof AppUpdateController>[0],
        'analytics' | 'progress' | 'environment' | 'diagnostics'
    > & { analytics?: AppUpdateAnalytics }
) {
    return new AppUpdateController({
        ...input,
        analytics: input.analytics ?? createTestAnalyticsWindow().updates,
        progress: {
            listen: (listener) =>
                listenWindowEvent('main', 'updater://download-progress', (payload) => {
                    if (typeof payload === 'number') listener(payload);
                }),
        },
        environment: {
            isOnline: () => navigator.onLine !== false,
            offlineMessage: () => t('settings.general.update.error.offline'),
        },
        diagnostics: log,
    });
}

export function createTestUpdateReminder(
    input: Omit<ConstructorParameters<typeof AppUpdateReminderController>[0], 'diagnostics'>
) {
    return new AppUpdateReminderController({ ...input, diagnostics: log });
}
