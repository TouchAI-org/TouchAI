import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import { databaseBackup, isDatabaseBackupCancelledError } from '@/database/backup';
import { setLocale, t } from '@/i18n';
import { messages } from '@/i18n/messages';

const fullFilterKey = 'database.backup.dialog.fullFilterName';

const locales = [
    {
        locale: 'en-US',
        filterName: 'Database backup file',
        exportTitle: 'Export data backup',
        importTitle: 'Import data backup',
        exporting: 'Exporting database...',
        importing: 'Importing database...',
        exported: 'Export complete',
        imported: 'Import complete',
        cancelled: 'Export cancelled',
    },
    {
        locale: 'zh-CN',
        filterName: '数据库备份文件',
        exportTitle: '导出数据备份',
        importTitle: '导入数据备份',
        exporting: '正在导出数据库...',
        importing: '正在导入数据库...',
        exported: '导出完成',
        imported: '导入完成',
        cancelled: '已取消导出',
    },
] as const;

describe.each(locales)('given a user manages data backups in $locale', (strings) => {
    beforeEach(() => {
        setLocale(strings.locale);
        mockTauriCommand('plugin:dialog|save', 'D:/backup.zip');
        mockTauriCommand('plugin:dialog|open', 'D:/backup.zip');
        mockTauriCommand('database_export_backup', undefined);
        mockTauriCommand('database_import_backup', undefined);
    });

    it('user sees translated filters and progress when exporting', async () => {
        const progress: Array<[string, number]> = [];

        await databaseBackup.exportDatabase((message, value) => progress.push([message, value]));

        expect(messages[strings.locale][fullFilterKey]).toBeTruthy();
        expect(t(fullFilterKey)).toBe(messages[strings.locale][fullFilterKey]);
        expect(t(fullFilterKey)).not.toBe(fullFilterKey);
        expect(getLastTauriInvokeCall('plugin:dialog|save')?.payload).toEqual({
            options: expect.objectContaining({
                title: strings.exportTitle,
                filters: [
                    { name: t(fullFilterKey), extensions: ['zip'] },
                    { name: strings.filterName, extensions: ['db'] },
                ],
            }),
        });
        expect(progress).toEqual([
            [strings.exporting, 30],
            [strings.exported, 100],
        ]);
    });

    it('user sees translated filters and progress when importing', async () => {
        const progress: Array<[string, number]> = [];

        await databaseBackup.importDatabase('full', (message, value) =>
            progress.push([message, value])
        );

        expect(getLastTauriInvokeCall('plugin:dialog|open')?.payload).toEqual({
            options: {
                title: strings.importTitle,
                filters: [
                    { name: t(fullFilterKey), extensions: ['zip'] },
                    { name: strings.filterName, extensions: ['db'] },
                ],
                multiple: false,
                directory: false,
            },
        });
        expect(progress).toEqual([
            [strings.importing, 30],
            [strings.imported, 100],
        ]);
    });

    it('user gets a translated cancellation when dismissing the save dialog', async () => {
        mockTauriCommand('plugin:dialog|save', null);
        const error: unknown = await databaseBackup
            .exportDatabase()
            .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(strings.cancelled);
        expect(isDatabaseBackupCancelledError(error)).toBe(true);
        expect(isDatabaseBackupCancelledError({ code: 'DATABASE_BACKUP_CANCELLED' })).toBe(true);
        expect(isDatabaseBackupCancelledError(new Error('other'))).toBe(false);
        expect(isDatabaseBackupCancelledError(null)).toBe(false);
    });
});
