import { beforeEach, describe, expect, it, vi } from 'vitest';

const { nativeMock, notificationPluginMock } = vi.hoisted(() => {
    const pluginMock = {
        isPermissionGranted: vi.fn(),
        requestPermission: vi.fn(),
        sendNotification: vi.fn(),
    };

    return {
        nativeMock: {
            window: {
                showSessionStatusReminderNotification: vi.fn().mockResolvedValue(undefined),
                clearSessionStatusReminderNotifications: vi.fn().mockResolvedValue(undefined),
            },
        },
        notificationPluginMock: pluginMock,
    };
});

vi.mock('@tauri-apps/plugin-notification', () => notificationPluginMock);
vi.mock('@services/NativeService', () => ({
    native: nativeMock,
}));

async function importNotificationService() {
    return import('@/services/NotificationService');
}

describe('NotificationService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();

        notificationPluginMock.isPermissionGranted.mockResolvedValue(true);
        notificationPluginMock.requestPermission.mockResolvedValue('granted');
    });

    it('routes session status reminders through the native window command', async () => {
        const service = await importNotificationService();

        service.notifySessionStatusReminder({
            title: 'TouchAI',
            body: 'Task completed',
            sessionId: 3,
            taskId: 'task-1',
            kind: 'completed',
            approval: null,
        });

        expect(nativeMock.window.showSessionStatusReminderNotification).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Task completed',
            sessionId: 3,
            taskId: 'task-1',
            kind: 'completed',
            approval: null,
        });
        expect(notificationPluginMock.sendNotification).not.toHaveBeenCalled();
    });

    it('keeps ordinary notifications on the plugin notification path', async () => {
        const service = await importNotificationService();

        service.notify({
            title: 'TouchAI',
            body: 'Regular reminder',
        });

        expect(notificationPluginMock.sendNotification).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Regular reminder',
        });
        expect(nativeMock.window.showSessionStatusReminderNotification).not.toHaveBeenCalled();
    });

    it('clears tracked status reminders through the native window command', async () => {
        const service = await importNotificationService();

        await service.clearStatusReminderNotifications();

        expect(nativeMock.window.clearSessionStatusReminderNotifications).toHaveBeenCalledTimes(1);
    });

    it('checks permission without registering a plugin action listener', async () => {
        const service = await importNotificationService();

        await service.initNotificationPermission();

        expect(notificationPluginMock.isPermissionGranted).toHaveBeenCalledTimes(1);
        expect(notificationPluginMock.requestPermission).not.toHaveBeenCalled();
    });
});
