import { invoke } from './invoke';

export type StorageCategory =
    | 'attachments'
    | 'clipboard'
    | 'thumbnails'
    | 'temporary'
    | 'recordings'
    | 'logs'
    | 'database'
    | 'assets'
    | 'browser';
export type StorageHistoryKind = 'sessions' | 'messages' | 'turns';

export interface StorageCategoryUsage {
    id: StorageCategory;
    bytes: number;
    reclaimableBytes: number;
    fileCount: number;
    olderThanDays?: Partial<Record<7 | 30 | 90, number>>;
}

export interface StorageSummary {
    categories: StorageCategoryUsage[];
    totalBytes: number;
    reclaimableBytes: number;
    databaseFreeBytes: number;
    warnings: string[];
    busy: boolean;
}

export interface StorageCleanupResult {
    removedFiles: number;
    releasedBytes: number;
    pendingBytes: number;
    failedFiles: number;
    failures: { path: string; code: string }[];
    summary: StorageSummary;
    restartRequired?: boolean;
}

export interface StorageCleanupSelection {
    unused: boolean;
    categories: StorageCategory[];
    olderThanDays?: Partial<Record<StorageCategory, 7 | 30 | 90>>;
    history?: StorageHistoryKind;
    logScope?: 'activity' | 'crashes';
}

export interface StorageCompactionResult {
    beforeBytes: number;
    afterBytes: number;
    releasedBytes: number;
}

export interface DataLocationInfo {
    currentPath: string;
    pendingPath: string | null;
    notice: string | null;
    previousPath: string | null;
}

export interface StoragePublishedAttachment {
    hash: string;
    path: string;
    size: number;
}

export const SAFE_STORAGE_CATEGORIES: readonly StorageCategory[] = [
    'attachments',
    'clipboard',
    'thumbnails',
    'temporary',
];

export const storage = {
    getLocation(): Promise<DataLocationInfo> {
        return invoke('storage_get_location');
    },
    scheduleMove(destination: string): Promise<DataLocationInfo> {
        return invoke('storage_schedule_move', { destination });
    },
    cancelMove(): Promise<DataLocationInfo> {
        return invoke('storage_cancel_move');
    },
    scan(): Promise<StorageSummary> {
        return invoke('storage_scan');
    },
    cleanup(
        categories: StorageCategory[] = [...SAFE_STORAGE_CATEGORIES]
    ): Promise<StorageCleanupResult> {
        return invoke('storage_cleanup', { categories });
    },
    cleanupSelected(selection: StorageCleanupSelection): Promise<StorageCleanupResult> {
        return invoke('storage_cleanup_selected', { selection });
    },
    compactDatabase(): Promise<StorageCompactionResult> {
        return invoke('storage_compact_database');
    },
    clearHistory(kind: StorageHistoryKind): Promise<void> {
        return invoke('storage_clear_history', { kind });
    },
    hold(): Promise<string> {
        return invoke('storage_hold');
    },
    pinPaths(paths: string[]): Promise<string> {
        return invoke('storage_pin_paths', { paths });
    },
    release(activityId: string): Promise<void> {
        return invoke('storage_release', { activityId });
    },
    publishAttachment(
        type: 'image' | 'file',
        sourcePath: string,
        expectedHash?: string,
        aliasSourcePath?: string
    ): Promise<StoragePublishedAttachment> {
        return invoke('storage_publish_attachment', {
            attachmentType: type,
            sourcePath,
            expectedHash,
            aliasSourcePath,
        });
    },
} as const;
