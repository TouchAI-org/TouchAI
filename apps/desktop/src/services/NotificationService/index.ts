// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { native } from '@services/NativeService';
import type { SessionStatusReminderNotificationPayload } from '@services/NativeService/types';
import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from '@tauri-apps/plugin-notification';

let permissionGranted = false;

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

export function notify(options: { title: string; body: string }): void {
    if (!permissionGranted) {
        console.warn(
            '[NotificationService] Notification permission not granted, attempting anyway'
        );
    }

    try {
        sendNotification(options);
    } catch (error) {
        console.error('[NotificationService] Failed to send notification:', error);
    }
}

export function notifySessionStatusReminder(
    payload: SessionStatusReminderNotificationPayload
): void {
    try {
        void native.window.showSessionStatusReminderNotification(payload).catch((error) => {
            console.error(
                '[NotificationService] Failed to send session status reminder notification:',
                error
            );
        });
    } catch (error) {
        console.error(
            '[NotificationService] Failed to queue session status reminder notification:',
            error
        );
    }
}

export async function clearStatusReminderNotifications(): Promise<void> {
    try {
        await native.window.clearSessionStatusReminderNotifications();
    } catch (error) {
        console.error(
            '[NotificationService] Failed to clear status reminder notifications:',
            error
        );
    }
}
