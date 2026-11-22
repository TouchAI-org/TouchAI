import type { AppUpdateChannel } from '@/config/appUpdate';
export type { AppUpdateChannel } from '@/config/appUpdate';

export interface AppUpdateInfo {
    version: string;
    fileName: string;
    notes: string | null;
    sizeBytes: number | null;
}

export interface AppUpdateInstallAnalytics {
    updateOperationId: string;
    source: 'background' | 'user' | 'other';
    /** Original native operation captured at update check start. */
    operationId?: string;
}

export interface AppUpdateNotificationAction {
    action: 'open' | 'update' | 'ignore';
    channel: AppUpdateChannel;
    version: string;
}

export interface AppUpdateNotificationPayload {
    channel: AppUpdateChannel;
    version: string;
    title: string;
    body: string;
    updateLabel: string;
    ignoreLabel: string;
}

export interface AppUpdateRequirement {
    required: boolean;
    minimumSupportedVersion: string | null;
    requiredSeverity: 'critical' | 'security' | 'recommended' | string | null;
    requiredReason: string | null;
    targetSatisfiesRequirement: boolean;
}

export interface AppUpdateDownload {
    kind: 'installer' | 'fullPackage' | 'deltaPackage' | 'updatePackage' | 'asset' | string;
    name: string;
    url: string;
    sizeBytes: number | null;
}

export interface AppUpdateChannelLatest {
    version: string;
    tag: string;
    releaseUrl: string;
    publishedAt: string | null;
    prerelease: boolean;
    releaseNotes: string | null;
    releaseNotesByLocale?: Record<string, string>;
    releaseHistory?: AppUpdateChannelReleaseNote[];
    downloads: AppUpdateDownload[];
}

export interface AppUpdateChannelReleaseNote {
    version: string;
    publishedAt: string | null;
    releaseNotes: string | null;
    releaseNotesByLocale?: Record<string, string>;
}

export type AppUpdateCheckResult =
    | {
          status: 'available';
          channel: AppUpdateChannel;
          currentVersion: string;
          latest: AppUpdateChannelLatest | null;
          update: AppUpdateInfo;
          requirement: AppUpdateRequirement;
      }
    | {
          status: 'not_available';
          channel: AppUpdateChannel;
          currentVersion: string;
          latest: AppUpdateChannelLatest | null;
          requirement: AppUpdateRequirement;
      }
    | {
          status: 'unsupported';
          channel: AppUpdateChannel;
          currentVersion: string | null;
          latest: AppUpdateChannelLatest | null;
          reason: 'not_installed' | 'platform_unsupported' | 'updater_unavailable';
          message: string;
          requirement: AppUpdateRequirement;
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
    | {
          type: 'check-reverted';
          status: AppUpdateStatus;
          error: string | null;
          unsupportedReason: AppUpdateUnsupportedReason | null;
      }
    | { type: 'check-abandoned' }
    | { type: 'download-started' }
    | { type: 'download-progress'; progress: number }
    | { type: 'download-completed'; update?: AppUpdateInfo | null }
    | { type: 'install-started' }
    | { type: 'failed'; error: string };
