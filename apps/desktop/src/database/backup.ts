// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { native } from '@services/NativeService';
import { open, save } from '@tauri-apps/plugin-dialog';

import { t } from '@/i18n';

export type ImportMode = 'chat_only' | 'full';

export interface ProgressCallback {
    (message: string, progress: number): void;
}

export class DatabaseBackupCommittedError extends Error {
    readonly code = 'DATABASE_BACKUP_COMMITTED';

    constructor() {
        super(t('database.backup.importCleanupPending'));
        this.name = 'DatabaseBackupCommittedError';
    }
}

export function isDatabaseBackupCommittedError(
    error: unknown
): error is DatabaseBackupCommittedError {
    return error instanceof DatabaseBackupCommittedError;
}

export class DatabaseBackupCancelledError extends Error {
    readonly code = 'DATABASE_BACKUP_CANCELLED';

    constructor(message: string) {
        super(message);
        this.name = 'DatabaseBackupCancelledError';
    }
}

export function isDatabaseBackupCancelledError(
    error: unknown
): error is DatabaseBackupCancelledError {
    return (
        error instanceof DatabaseBackupCancelledError ||
        (typeof error === 'object' &&
            error !== null &&
            (error as { code?: unknown }).code === 'DATABASE_BACKUP_CANCELLED')
    );
}

/**
 * 数据库备份服务。
 *
 * 备份/导入本质上属于数据库运维能力，前端只负责文件选择和进度展示。
 */
class DatabaseBackupService {
    /**
     * 导出数据库备份。
     */
    async exportDatabase(onProgress?: ProgressCallback): Promise<string> {
        const exportPath = await save({
            defaultPath: this.buildBackupFileName(),
            filters: [
                {
                    name: t('database.backup.dialog.fullFilterName'),
                    extensions: ['zip'],
                },
                {
                    name: t('database.backup.dialog.filterName'),
                    extensions: ['db'],
                },
            ],
            title: t('database.backup.dialog.exportTitle'),
        });

        if (!exportPath) {
            throw new DatabaseBackupCancelledError(t('database.backup.exportCancelled'));
        }

        onProgress?.(t('database.backup.exporting'), 30);
        await native.database.exportBackup(exportPath);
        onProgress?.(t('database.backup.exportComplete'), 100);

        return exportPath;
    }

    /**
     * 导入数据库备份。
     *
     * 返回 false 只表示用户取消了文件选择；导入成功返回 true，导入失败直接抛出错误。
     */
    async importDatabase(mode: ImportMode, onProgress?: ProgressCallback): Promise<boolean> {
        const sourcePath = await open({
            filters: [
                {
                    name: t('database.backup.dialog.fullFilterName'),
                    extensions: ['zip'],
                },
                {
                    name: t('database.backup.dialog.filterName'),
                    extensions: ['db'],
                },
            ],
            title: t('database.backup.dialog.importTitle'),
            multiple: false,
            directory: false,
        });

        if (!sourcePath) {
            return false;
        }

        onProgress?.(t('database.backup.importing'), 30);
        try {
            await native.database.importBackup({ sourcePath, mode });
        } catch (error) {
            const message =
                typeof error === 'string' ? error : error instanceof Error ? error.message : '';
            if (message.startsWith('database_import_usage_conflict')) {
                const conflict = new Error(t('database.backup.usageConflict'));
                (conflict as Error & { cause?: unknown }).cause = error;
                throw conflict;
            }
            if (message.startsWith('database_import_committed:'))
                throw new DatabaseBackupCommittedError();
            throw error;
        }
        onProgress?.(t('database.backup.importComplete'), 100);

        return true;
    }

    /**
     * 生成备份文件名。
     */
    private buildBackupFileName(): string {
        const timestamp = Math.floor(Date.now() / 1000);
        return `touchai-backup-${timestamp}.zip`;
    }
}

export const databaseBackup = new DatabaseBackupService();
