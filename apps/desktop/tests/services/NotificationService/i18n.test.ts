import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';

const { isPermissionGrantedMock, requestPermissionMock, sendNotificationMock } = vi.hoisted(() => ({
    isPermissionGrantedMock: vi.fn(),
    requestPermissionMock: vi.fn(),
    sendNotificationMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: isPermissionGrantedMock,
    requestPermission: requestPermissionMock,
    sendNotification: sendNotificationMock,
}));

describe('NotificationService i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        isPermissionGrantedMock.mockResolvedValue(true);
        requestPermissionMock.mockResolvedValue('granted');
    });

    it('requests notification permission when it has not been granted yet', async () => {
        isPermissionGrantedMock.mockResolvedValueOnce(false);
        requestPermissionMock.mockResolvedValueOnce('granted');
        const { initNotificationPermission } = await import('@services/NotificationService');

        await initNotificationPermission();

        expect(isPermissionGrantedMock).toHaveBeenCalled();
        expect(requestPermissionMock).toHaveBeenCalled();
    });

    it('skips permission request when notification permission already exists', async () => {
        isPermissionGrantedMock.mockResolvedValueOnce(true);
        const { initNotificationPermission } = await import('@services/NotificationService');

        await initNotificationPermission();

        expect(isPermissionGrantedMock).toHaveBeenCalled();
        expect(requestPermissionMock).not.toHaveBeenCalled();
    });

    it('keeps notification initialization non-fatal when permission checks fail', async () => {
        isPermissionGrantedMock.mockRejectedValueOnce(new Error('permission backend down'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { initNotificationPermission } = await import('@services/NotificationService');

        await expect(initNotificationPermission()).resolves.toBeUndefined();

        expect(consoleSpy).toHaveBeenCalledWith(
            '[NotificationService] Permission check/request failed:',
            expect.any(Error)
        );
        consoleSpy.mockRestore();
    });

    it('translates notification title and body for the active locale', async () => {
        setLocale('en-US');
        const { notify } = await import('@services/NotificationService');

        notify({
            titleSource: 'TouchAI - 快捷键注册失败',
            bodySource: '复制失败',
        });

        expect(sendNotificationMock).toHaveBeenCalledWith({
            title: 'TouchAI - Shortcut registration failed',
            body: 'Copy failed',
        });
    });

    it('keeps Chinese notifications unchanged in the default locale', async () => {
        const { notify } = await import('@services/NotificationService');

        notify({
            title: 'TouchAI',
            bodySource: '已复制到剪贴板',
        });

        expect(sendNotificationMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: '已复制到剪贴板',
        });
    });

    it('translates notification source templates with params for dynamic content', async () => {
        setLocale('en-US');
        const { notify } = await import('@services/NotificationService');

        notify({
            titleSource: 'TouchAI - 快捷键注册失败',
            bodySource: '快捷键 {shortcut} 已被其他应用占用',
            bodyParams: {
                shortcut: 'Alt+Space',
            },
        });

        expect(sendNotificationMock).toHaveBeenCalledWith({
            title: 'TouchAI - Shortcut registration failed',
            body: 'Shortcut Alt+Space is already used by another app',
        });
    });

    it('does not translate raw runtime notification text implicitly', async () => {
        setLocale('en-US');
        const { notify } = await import('@services/NotificationService');

        notify({
            title: 'TouchAI - 请求失败',
            body: '设置',
        });

        expect(sendNotificationMock).toHaveBeenCalledWith({
            title: 'TouchAI - 请求失败',
            body: '设置',
        });
    });

    it('warns but still sends when notification permission is unavailable', async () => {
        isPermissionGrantedMock.mockResolvedValueOnce(false);
        requestPermissionMock.mockResolvedValueOnce('denied');
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { initNotificationPermission, notify } = await import(
            '@services/NotificationService'
        );

        await initNotificationPermission();
        notify({
            title: 'TouchAI',
            body: 'Raw body',
        });

        expect(consoleSpy).toHaveBeenCalledWith(
            '[NotificationService] Notification permission not granted, attempting anyway'
        );
        expect(sendNotificationMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Raw body',
        });
        consoleSpy.mockRestore();
    });

    it('logs notification send failures without throwing', async () => {
        sendNotificationMock.mockImplementationOnce(() => {
            throw new Error('notification backend down');
        });
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        isPermissionGrantedMock.mockResolvedValueOnce(true);
        const { initNotificationPermission, notify } = await import('@services/NotificationService');

        await initNotificationPermission();
        expect(() =>
            notify({
                title: 'TouchAI',
                body: 'Raw body',
            })
        ).not.toThrow();

        expect(consoleSpy).toHaveBeenCalledWith(
            '[NotificationService] Failed to send notification:',
            expect.any(Error)
        );
        consoleSpy.mockRestore();
    });
});
