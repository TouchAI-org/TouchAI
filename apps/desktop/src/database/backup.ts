// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { native } from '@services/NativeService';
import { open, save } from '@tauri-apps/plugin-dialog';

export type ImportMode = 'chat_only' | 'full';

export enum DatabaseVersionStatus {
    Compatible = 'compatible',
    NeedsMigration = 'needs_migration',
    TooNew = 'too_new',
}

export interface ImportResult {
    sourcePath: string;
    importMode: ImportMode;
    currentBackupPath: string;
    sourceBackupPath: string | null;
    migratedSource: boolean;
}

export interface ProgressCallback {
    (message: string, progress: number): void;
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
                    name: '数据库备份文件',
                    extensions: ['db'],
                },
            ],
            title: '导出设置备份',
        });

        if (!exportPath) {
            throw new Error('已取消导出');
        }

        onProgress?.('正在导出数据库...', 30);
        await native.database.exportBackup(exportPath);
        onProgress?.('导出完成', 100);

        return exportPath;
    }

    /**
     * 导入数据库备份。
     */
    async importDatabase(mode: ImportMode, onProgress?: ProgressCallback): Promise<ImportResult> {
        const sourcePath = await open({
            filters: [
                {
                    name: '数据库备份文件',
                    extensions: ['db'],
                },
            ],
            title: '导入设置备份',
            multiple: false,
            directory: false,
        });

        if (!sourcePath) {
            return {
                sourcePath: '',
                importMode: mode,
                currentBackupPath: '',
                sourceBackupPath: null,
                migratedSource: false,
            };
        }

        onProgress?.('正在导入数据库...', 30);
        await native.database.importBackup({
            sourcePath,
            mode,
        });
        onProgress?.('导入完成', 100);

        return {
            sourcePath,
            importMode: mode,
            currentBackupPath: '',
            sourceBackupPath: null,
            migratedSource: false,
        };
    }

    /**
     * 生成备份文件名。
     */
    private buildBackupFileName(): string {
        const timestamp = Math.floor(Date.now() / 1000);
        return `touchai-backup-${timestamp}.db`;
    }
}

export const databaseBackup = new DatabaseBackupService();
