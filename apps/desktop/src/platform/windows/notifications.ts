import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from '@tauri-apps/plugin-notification';

import { log } from '@/platform/diagnostics';

let permissionGranted = false;

export async function initNotificationPermission(): Promise<void> {
    try {
        permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
            const result = await requestPermission();
            permissionGranted = result === 'granted';
        }
    } catch (error) {
        log.error('[NotificationService] Permission check/request failed:', error);
    }
}

export function sendWindowNotification(options: { title: string; body: string }): void {
    if (!permissionGranted) {
        log.warn('[NotificationService] Notification permission not granted, attempting anyway');
    }
    try {
        sendNotification(options);
    } catch (error) {
        log.error('[NotificationService] Failed to send notification:', error);
    }
}
