import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import {
    databaseBackup,
    DatabaseBackupCancelledError,
    isDatabaseBackupCancelledError,
} from '@/services/DataManagementService';

const { exportBackupMock, importBackupMock, openMock, saveMock } = vi.hoisted(() => ({
    exportBackupMock: vi.fn(),
    importBackupMock: vi.fn(),
    openMock: vi.fn(),
    saveMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: openMock,
    save: saveMock,
}));

vi.mock('@services/NativeService', () => ({
    native: {
        database: {
            exportBackup: exportBackupMock,
            importBackup: importBackupMock,
        },
    },
}));

describe('DataManagementService databaseBackup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
        saveMock.mockResolvedValue('D:/backups/touchai.db');
        openMock.mockResolvedValue('D:/backups/import-source.db');
        exportBackupMock.mockResolvedValue(undefined);
        importBackupMock.mockResolvedValue(undefined);
    });

    it('exports through the native database backup command and reports ordered progress', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_765_000_000_000);
        const onProgress = vi.fn();

        await expect(databaseBackup.exportDatabase(onProgress)).resolves.toBe(
            'D:/backups/touchai.db'
        );

        expect(saveMock).toHaveBeenCalledWith(
            expect.objectContaining({
                defaultPath: 'touchai-backup-1765000000.db',
                title: 'Export settings backup',
            })
        );
        expect(exportBackupMock).toHaveBeenCalledWith('D:/backups/touchai.db');
        expect(onProgress.mock.calls).toEqual([
            ['Exporting database...', 30],
            ['Export complete', 100],
        ]);
    });

    it('does not report export completion when the native backup command fails', async () => {
        const onProgress = vi.fn();
        exportBackupMock.mockRejectedValueOnce(new Error('disk full'));

        await expect(databaseBackup.exportDatabase(onProgress)).rejects.toThrow('disk full');

        expect(onProgress.mock.calls).toEqual([['Exporting database...', 30]]);
    });

    it('imports through the native database backup command and returns the selected source path', async () => {
        const onProgress = vi.fn();

        await expect(databaseBackup.importDatabase('full', onProgress)).resolves.toEqual({
            sourcePath: 'D:/backups/import-source.db',
            importMode: 'full',
            currentBackupPath: '',
            sourceBackupPath: null,
            migratedSource: false,
        });

        expect(openMock).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Import settings backup',
                multiple: false,
                directory: false,
            })
        );
        expect(importBackupMock).toHaveBeenCalledWith({
            sourcePath: 'D:/backups/import-source.db',
            mode: 'full',
        });
        expect(onProgress.mock.calls).toEqual([
            ['Importing database...', 30],
            ['Import complete', 100],
        ]);
    });

    it('does not report import completion when the native import command fails', async () => {
        const onProgress = vi.fn();
        importBackupMock.mockRejectedValueOnce(new Error('invalid backup'));

        await expect(databaseBackup.importDatabase('chat_only', onProgress)).rejects.toThrow(
            'invalid backup'
        );

        expect(onProgress.mock.calls).toEqual([['Importing database...', 30]]);
    });

    it('uses a typed cancellation error for cancelled exports', async () => {
        saveMock.mockResolvedValueOnce(null);

        await expect(databaseBackup.exportDatabase()).rejects.toMatchObject({
            name: 'DatabaseBackupCancelledError',
            code: 'DATABASE_BACKUP_CANCELLED',
            message: 'Export cancelled',
        });
        expect(isDatabaseBackupCancelledError(new DatabaseBackupCancelledError('cancel'))).toBe(
            true
        );
    });
});
