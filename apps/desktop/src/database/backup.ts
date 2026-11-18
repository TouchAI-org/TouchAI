// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { native } from '@services/NativeService';
import type { DatabaseImportMode } from '@services/NativeService/database';
import { open, save } from '@tauri-apps/plugin-dialog';

import { t } from '@/i18n';

export type ImportMode = DatabaseImportMode;

function archiveFilters(mode: ImportMode) {
    const filters = [
        {
            name: t(
                mode === 'full'
                    ? 'database.backup.dialog.fullFilterName'
                    : 'database.backup.dialog.archiveFilterName'
            ),
            extensions: ['zip'],
        },
    ];
    if (mode === 'full')
        filters.push({ name: t('database.backup.dialog.filterName'), extensions: ['db'] });
    return filters;
}

async function selectBackupFile() {
    return open({
        filters: archiveFilters('full'),
        title: t('database.backup.dialog.importTitle'),
        multiple: false,
        directory: false,
    });
}

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
    async exportDatabase(
        onProgress?: ProgressCallback,
        mode: ImportMode = 'full'
    ): Promise<string> {
        const exportPath = await save({
            defaultPath: this.buildBackupFileName(mode),
            filters: archiveFilters(mode),
            title: t('database.backup.dialog.exportTitle'),
        });

        if (!exportPath) {
            throw new DatabaseBackupCancelledError(t('database.backup.exportCancelled'));
        }

        onProgress?.(t('database.backup.exporting'), 30);
        if (mode !== 'full' && !exportPath.toLowerCase().endsWith('.zip')) {
            throw new Error(t('database.backup.archiveRequired'));
        }
        await native.database.exportBackup(exportPath, mode);
        onProgress?.(t('database.backup.exportComplete'), 100);

        return exportPath;
    }

    async selectImport(): Promise<{ path: string; scope: ImportMode } | null> {
        const path = await selectBackupFile();
        if (!path) return null;
        const scope = path.toLowerCase().endsWith('.db')
            ? 'full'
            : await native.database.backupScope(path);
        return { path, scope };
    }

    async importDatabase(
        mode: ImportMode,
        onProgress?: ProgressCallback,
        selectedPath?: string
    ): Promise<boolean> {
        const sourcePath = selectedPath ?? (await selectBackupFile());

        if (!sourcePath) {
            return false;
        }

        onProgress?.(t('database.backup.importing'), 30);
        try {
            await native.database.importBackup({ sourcePath, mode });
        } catch (error) {
            const message =
                typeof error === 'string' ? error : error instanceof Error ? error.message : '';
            const reason = message.startsWith('database_backup_scope_unavailable')
                ? 'database.backup.scopeUnavailable'
                : message.startsWith('database_import_usage_conflict')
                  ? 'database.backup.usageConflict'
                  : null;
            if (reason) {
                const refusal = new Error(t(reason));
                (refusal as Error & { cause?: unknown }).cause = error;
                throw refusal;
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
    private buildBackupFileName(mode: ImportMode): string {
        const timestamp = Math.floor(Date.now() / 1000);
        const prefix = { full: 'backup', chat_only: 'data', settings_only: 'settings' }[mode];
        return `touchai-${prefix}-${timestamp}.zip`;
    }
}

export const databaseBackup = new DatabaseBackupService();
