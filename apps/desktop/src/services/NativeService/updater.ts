import { invoke } from '@tauri-apps/api/core';

import type { AppUpdateChannel, AppUpdateCheckResult, AppUpdateInfo } from './types';

export const updater = {
    checkForUpdates(channel: AppUpdateChannel): Promise<AppUpdateCheckResult> {
        return invoke<AppUpdateCheckResult>('updater_check_for_updates', { channel });
    },

    downloadUpdate(): Promise<AppUpdateInfo> {
        return invoke<AppUpdateInfo>('updater_download_update');
    },

    installUpdate(): Promise<boolean> {
        return invoke<boolean>('updater_install_update');
    },
} as const;
