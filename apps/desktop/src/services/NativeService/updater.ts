import { invoke } from '@tauri-apps/api/core';

import type {
    AppUpdateChannel,
    AppUpdateCheckResult,
    AppUpdateInfo,
    AppUpdateNotificationPayload,
} from './types';

export const updater = {
    checkForUpdates(channel: AppUpdateChannel): Promise<AppUpdateCheckResult> {
        return invoke<AppUpdateCheckResult>('updater_check_for_updates', { channel });
    },

    downloadUpdate(
        channel: AppUpdateChannel,
        version: string,
        fileName: string
    ): Promise<AppUpdateInfo> {
        return invoke<AppUpdateInfo>('updater_download_update', { channel, version, fileName });
    },

    installUpdate(channel: AppUpdateChannel, version: string, fileName: string): Promise<boolean> {
        return invoke<boolean>('updater_install_update', { channel, version, fileName });
    },

    showUpdateNotification(payload: AppUpdateNotificationPayload): Promise<void> {
        return invoke('updater_show_update_notification', { payload });
    },

    openUpdateSettings(): Promise<void> {
        return invoke('updater_open_update_settings');
    },
} as const;
