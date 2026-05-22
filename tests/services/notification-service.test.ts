import { beforeEach, describe, expect, it, vi } from 'vitest';

const notificationPluginMock = vi.hoisted(() => ({
    isPermissionGranted: vi.fn(),
    removeActive: vi.fn(),
    requestPermission: vi.fn(),
    sendNotification: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-notification', () => notificationPluginMock);

async function importNotificationService() {
    return import('@/services/NotificationService');
}

describe('NotificationService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();

        notificationPluginMock.isPermissionGranted.mockResolvedValue(true);
        notificationPluginMock.requestPermission.mockResolvedValue('granted');
        notificationPluginMock.removeActive.mockResolvedValue(undefined);
    });

    it('tracks background status reminder notifications and clears them by id', async () => {
        const service = await importNotificationService();

        service.notify(
            {
                title: 'TouchAI',
                body: '任务已完成',
            },
            {
                trackAsStatusReminder: true,
            }
        );

        expect(notificationPluginMock.sendNotification).toHaveBeenCalledWith({
            id: 1,
            title: 'TouchAI',
            body: '任务已完成',
        });

        await service.clearStatusReminderNotifications();

        expect(notificationPluginMock.removeActive).toHaveBeenCalledWith([{ id: 1 }]);
    });

    it('does not clear unrelated notifications when no tracked reminders exist', async () => {
        const service = await importNotificationService();

        service.notify({
            title: 'TouchAI',
            body: '普通提醒',
        });

        await service.clearStatusReminderNotifications();

        expect(notificationPluginMock.sendNotification).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: '普通提醒',
        });
        expect(notificationPluginMock.removeActive).not.toHaveBeenCalled();
    });
});
