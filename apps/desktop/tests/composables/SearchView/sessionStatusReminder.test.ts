import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { describe, expect, it } from 'vitest';
import { createApp } from 'vue';

import { createSessionStatusReminderCoordinator } from '@/views/SearchView/composables/sessionStatusReminder';

describe('given a background session that needs attention', () => {
    it('user receives the notification when updating the tray indicator fails', async () => {
        mockTauriCommand('set_tray_status_indicator', () => {
            throw new Error('tray unavailable');
        });
        const presentation = await createTestWindowPresentation('main');
        const app = createApp({ render: () => null });
        presentation.provide(app);
        const coordinator = app.runWithContext(() =>
            createSessionStatusReminderCoordinator({
                isSearchSurfaceForegrounded: () => false,
            })
        );

        coordinator.handleTaskStatusChanged({
            sessionId: 1,
            taskId: 'reminder-task',
            previousStatus: 'running',
            status: 'completed',
            reminder: { kind: 'completed', title: 'Session finished', body: 'Ready to view' },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(getTauriInvokeCalls('show_session_status_reminder_notification')).toHaveLength(1);
        expect(getTauriInvokeCalls('set_tray_status_indicator')).toHaveLength(1);
    });
});
