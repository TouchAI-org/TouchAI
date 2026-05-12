// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

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
        console.warn('[NotificationService] Notification permission not granted, attempting anyway');
    }
    try {
        sendNotification(options);
    } catch (error) {
        console.error('[NotificationService] Failed to send notification:', error);
    }
}
