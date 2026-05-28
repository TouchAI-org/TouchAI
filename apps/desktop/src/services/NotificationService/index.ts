// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from '@tauri-apps/plugin-notification';

import { type MessageParams, type SourceText, tt } from '@/i18n';

type NotificationTitle =
    | {
          title: string;
          titleSource?: never;
          titleParams?: never;
      }
    | {
          title?: never;
          titleSource: SourceText;
          titleParams?: MessageParams;
      }
    | {
          title?: never;
          titleSource?: never;
          titleParams?: never;
      };

type NotificationBody =
    | {
          body: string;
          bodySource?: never;
          bodyParams?: never;
      }
    | {
          body?: never;
          bodySource: SourceText;
          bodyParams?: MessageParams;
      }
    | {
          body?: never;
          bodySource?: never;
          bodyParams?: never;
      };

export type NotificationOptions = NotificationTitle & NotificationBody;

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

export function notify(options: NotificationOptions): void {
    if (!permissionGranted) {
        console.warn(
            '[NotificationService] Notification permission not granted, attempting anyway'
        );
    }

    try {
        sendNotification({
            title:
                options.titleSource !== undefined
                    ? tt(options.titleSource, options.titleParams)
                    : (options.title ?? ''),
            body:
                options.bodySource !== undefined
                    ? tt(options.bodySource, options.bodyParams)
                    : (options.body ?? ''),
        });
    } catch (error) {
        console.error('[NotificationService] Failed to send notification:', error);
    }
}
