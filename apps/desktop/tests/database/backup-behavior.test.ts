import { getLastTauriInvokeCall, getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { databaseBackup, isDatabaseBackupCancelledError } from '@/database/backup';
import { setLocale, t } from '@/i18n';

describe('given a user selects a data backup destination', () => {
    beforeEach(() => {
        setLocale('en-US');
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        mockTauriCommand('plugin:dialog|save', 'D:/backups/full.zip');
        mockTauriCommand('database_export_backup', undefined);
    });

    it('user gets a full archive by default when exporting', async () => {
        await expect(databaseBackup.exportDatabase()).resolves.toBe('D:/backups/full.zip');

        expect(getLastTauriInvokeCall('plugin:dialog|save')?.payload).toEqual({
            options: {
                defaultPath: 'touchai-backup-1800000000.zip',
                filters: [
                    {
                        name: t('database.backup.dialog.fullFilterName'),
                        extensions: ['zip'],
                    },
                    { name: 'Database backup file', extensions: ['db'] },
                ],
                title: 'Export data backup',
            },
        });
        expect(getLastTauriInvokeCall('database_export_backup')?.payload).toEqual({
            targetPath: 'D:/backups/full.zip',
        });
    });

    it('user can export a database-only backup when choosing its filter', async () => {
        mockTauriCommand('plugin:dialog|save', 'D:/backups/legacy.db');

        await expect(databaseBackup.exportDatabase()).resolves.toBe('D:/backups/legacy.db');

        expect(getLastTauriInvokeCall('database_export_backup')?.payload).toEqual({
            targetPath: 'D:/backups/legacy.db',
        });
    });

    it('user exports nothing when dismissing the destination dialog', async () => {
        mockTauriCommand('plugin:dialog|save', null);
        const progress: Array<[string, number]> = [];
        const result = databaseBackup.exportDatabase((message, value) => {
            progress.push([message, value]);
        });

        await expect(result).rejects.toMatchObject({
            name: 'DatabaseBackupCancelledError',
            code: 'DATABASE_BACKUP_CANCELLED',
            message: 'Export cancelled',
        });
        expect(isDatabaseBackupCancelledError(await result.catch((error: unknown) => error))).toBe(
            true
        );
        expect(progress).toEqual([]);
        expect(getTauriInvokeCalls('database_export_backup')).toEqual([]);
    });

    it('user sees no completion when exporting fails', async () => {
        const failure = new Error('backup destination is not writable');
        mockTauriCommand('database_export_backup', () => {
            throw failure;
        });
        const progress: Array<[string, number]> = [];

        await expect(
            databaseBackup.exportDatabase((message, value) => progress.push([message, value]))
        ).rejects.toBe(failure);

        expect(progress).toEqual([['Exporting database...', 30]]);
    });
});

describe('given a user selects a saved data backup', () => {
    beforeEach(() => {
        setLocale('en-US');
        mockTauriCommand('database_import_backup', undefined);
    });

    it.each([
        ['D:/backups/full.zip', 'full'],
        ['D:/backups/full.zip', 'chat_only'],
        ['D:/backups/legacy.db', 'full'],
        ['D:/backups/legacy.db', 'chat_only'],
    ] as const)(
        'user restores %s with the selected %s mode when opening a supported backup',
        async (sourcePath, mode) => {
            mockTauriCommand('plugin:dialog|open', sourcePath);
            const progress: Array<[string, number]> = [];

            await expect(
                databaseBackup.importDatabase(mode, (message, value) =>
                    progress.push([message, value])
                )
            ).resolves.toBe(true);

            expect(getLastTauriInvokeCall('database_import_backup')?.payload).toEqual({
                request: { sourcePath, mode },
            });
            expect(progress).toEqual([
                ['Importing database...', 30],
                ['Import complete', 100],
            ]);
        }
    );

    it('user imports nothing when dismissing the source dialog', async () => {
        mockTauriCommand('plugin:dialog|open', null);
        const progress: Array<[string, number]> = [];

        await expect(
            databaseBackup.importDatabase('full', (message, value) =>
                progress.push([message, value])
            )
        ).resolves.toBe(false);

        expect(progress).toEqual([]);
        expect(getTauriInvokeCalls('database_import_backup')).toEqual([]);
    });

    it('user sees a safe merge refusal when archived usage overlaps instead of losing or duplicating totals', async () => {
        mockTauriCommand('plugin:dialog|open', 'D:/backups/full.zip');
        mockTauriCommand('database_import_backup', () => {
            throw 'database_import_usage_conflict';
        });
        await expect(databaseBackup.importDatabase('full')).rejects.toThrow(
            t('database.backup.usageConflict')
        );
    });

    it('user is told when data committed despite a cleanup failure instead of treating it as a rolled-back import', async () => {
        mockTauriCommand('plugin:dialog|open', 'D:/backups/full.zip');
        mockTauriCommand('database_import_backup', () => {
            throw 'database_import_committed:temporary workspace cleanup failed';
        });
        await expect(databaseBackup.importDatabase('full')).rejects.toMatchObject({
            code: 'DATABASE_BACKUP_COMMITTED',
            message: t('database.backup.importCleanupPending'),
        });
    });

    it('user can select another backup when restoring fails', async () => {
        mockTauriCommand('plugin:dialog|open', 'D:/backups/corrupt.zip');
        const failure = new Error('full backup contains an invalid content hash');
        mockTauriCommand('database_import_backup', () => {
            throw failure;
        });
        const progress: Array<[string, number]> = [];

        await expect(
            databaseBackup.importDatabase('full', (message, value) =>
                progress.push([message, value])
            )
        ).rejects.toBe(failure);
        expect(progress).toEqual([['Importing database...', 30]]);

        mockTauriCommand('plugin:dialog|open', 'D:/backups/valid.zip');
        mockTauriCommand('database_import_backup', undefined);
        await expect(databaseBackup.importDatabase('full')).resolves.toBe(true);
    });
});
