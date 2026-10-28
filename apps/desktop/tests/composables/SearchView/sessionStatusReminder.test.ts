import { native } from '@services/NativeService';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionStatusReminderCoordinator } from '@/views/SearchView/composables/sessionStatusReminder';

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            setTrayStatusIndicator: vi.fn(),
            clearTrayStatusIndicator: vi.fn(),
            clearSessionStatusReminderNotifications: vi.fn(),
            showSessionStatusReminderNotification: vi.fn(),
        },
    },
}));

describe('user is reminded about a session that needs attention', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(native.window.setTrayStatusIndicator).mockResolvedValue(undefined);
        vi.mocked(native.window.clearTrayStatusIndicator).mockResolvedValue(undefined);
        vi.mocked(native.window.clearSessionStatusReminderNotifications).mockResolvedValue(
            undefined
        );
        vi.mocked(native.window.showSessionStatusReminderNotification).mockResolvedValue(undefined);
    });

    it('user still gets the notification when the tray indicator cannot be updated', async () => {
        vi.mocked(native.window.setTrayStatusIndicator).mockRejectedValue(
            new Error('tray unavailable')
        );
        const coordinator = createSessionStatusReminderCoordinator({
            isSearchSurfaceForegrounded: () => false,
        });

        coordinator.handleTaskStatusChanged({
            sessionId: 1,
            taskId: 2,
            previousStatus: 'running',
            status: 'running',
            reminder: { kind: 'completed' },
        } as never);
        await Promise.resolve();
        await Promise.resolve();

        expect(native.window.showSessionStatusReminderNotification).toHaveBeenCalled();
    });
});
