import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notificationPluginMock } = vi.hoisted(() => {
    const pluginMock = {
        isPermissionGranted: vi.fn(),
        requestPermission: vi.fn(),
        sendNotification: vi.fn(),
    };

    return {
        notificationPluginMock: pluginMock,
    };
});

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
    });

    it('checks permission without registering a plugin action listener', async () => {
        const service = await importNotificationService();

        await service.initNotificationPermission();

        expect(notificationPluginMock.isPermissionGranted).toHaveBeenCalledTimes(1);
        expect(notificationPluginMock.requestPermission).not.toHaveBeenCalled();
    });

    it('requests permission when it is not granted yet', async () => {
        notificationPluginMock.isPermissionGranted.mockResolvedValue(false);
        notificationPluginMock.requestPermission.mockResolvedValue('granted');
        const service = await importNotificationService();

        await service.initNotificationPermission();

        expect(notificationPluginMock.isPermissionGranted).toHaveBeenCalledTimes(1);
        expect(notificationPluginMock.requestPermission).toHaveBeenCalledTimes(1);
    });
});
