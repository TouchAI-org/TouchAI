import type {
    AppUpdateChannel,
    AppUpdateChannelLatest,
    AppUpdateCheckResult,
    AppUpdateInfo,
    AppUpdateRequirement,
} from '@services/NativeService/types';

export type {
    AppUpdateChannel,
    AppUpdateChannelLatest,
    AppUpdateCheckResult,
    AppUpdateInfo,
    AppUpdateRequirement,
};
export type AppUpdateUnsupportedReason = Extract<
    AppUpdateCheckResult,
    { status: 'unsupported' }
>['reason'];

export type AppUpdateStatus =
    | 'idle'
    | 'checking'
    | 'available'
    | 'not_available'
    | 'unsupported'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'failed';

export interface AppUpdateState {
    status: AppUpdateStatus;
    channel: AppUpdateChannel;
    autoCheckEnabled: boolean;
    currentVersion: string | null;
    availableUpdate: AppUpdateInfo | null;
    downloadedUpdate: AppUpdateInfo | null;
    latestUpdate: AppUpdateChannelLatest | null;
    updateRequirement: AppUpdateRequirement | null;
    downloadProgress: number | null;
    lastCheckedAt: string | null;
    error: string | null;
    unsupportedReason: AppUpdateUnsupportedReason | null;
}

export type AppUpdateAction =
    | {
          type: 'settings-loaded';
          channel: AppUpdateChannel;
          autoCheckEnabled: boolean;
          lastCheckedAt: string | null;
      }
    | { type: 'channel-updated'; channel: AppUpdateChannel }
    | { type: 'auto-check-updated'; enabled: boolean }
    | { type: 'check-started'; channel: AppUpdateChannel }
    | {
          type: 'check-completed';
          channel: AppUpdateChannel;
          result: AppUpdateCheckResult;
          checkedAt: string;
      }
    | { type: 'download-started' }
    | { type: 'download-progress'; progress: number }
    | { type: 'download-completed'; update?: AppUpdateInfo | null }
    | { type: 'install-started' }
    | { type: 'failed'; error: string };
