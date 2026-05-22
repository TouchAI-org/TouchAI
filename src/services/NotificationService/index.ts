// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import {
    isPermissionGranted,
    removeActive,
    requestPermission,
    sendNotification,
} from '@tauri-apps/plugin-notification';

let permissionGranted = false;
let nextStatusReminderNotificationId = 1;
const activeStatusReminderNotificationIds = new Set<number>();

function allocateStatusReminderNotificationId() {
    const notificationId = nextStatusReminderNotificationId;
    nextStatusReminderNotificationId =
        nextStatusReminderNotificationId >= 2_147_483_647
            ? 1
            : nextStatusReminderNotificationId + 1;
    return notificationId;
}

export async function initNotificationPermission(): Promise<void> {
    try {
        permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
            const result = await requestPermission();
            permissionGranted = result === 'granted';
        }
    } catch (error) {
        console.error('[NotificationService] Permission check/request failed:', error);
    }
}

export function notify(
    options: { title: string; body: string },
    metadata: {
        trackAsStatusReminder?: boolean;
    } = {}
): void {
    if (!permissionGranted) {
        console.warn(
            '[NotificationService] Notification permission not granted, attempting anyway'
        );
    }

    const notificationId = metadata.trackAsStatusReminder
        ? allocateStatusReminderNotificationId()
        : null;

    try {
        sendNotification({
            ...options,
            ...(notificationId !== null ? { id: notificationId } : {}),
        });
        if (notificationId !== null) {
            activeStatusReminderNotificationIds.add(notificationId);
        }
    } catch (error) {
        if (notificationId !== null) {
            activeStatusReminderNotificationIds.delete(notificationId);
        }
        console.error('[NotificationService] Failed to send notification:', error);
    }
}

export async function clearStatusReminderNotifications(): Promise<void> {
    if (activeStatusReminderNotificationIds.size === 0) {
        return;
    }

    const notifications = [...activeStatusReminderNotificationIds].map((id) => ({ id }));
    activeStatusReminderNotificationIds.clear();

    try {
        await removeActive(notifications);
    } catch (error) {
        console.error(
            '[NotificationService] Failed to clear status reminder notifications:',
            error
        );
    }
}
