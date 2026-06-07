import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';

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

describe('database backup native dialog i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        saveMock.mockResolvedValue('D:/backup.db');
        openMock.mockResolvedValue('D:/backup.db');
        exportBackupMock.mockResolvedValue(undefined);
        importBackupMock.mockResolvedValue(undefined);
    });

    it('uses English save dialog title and filter labels when exporting in English', async () => {
        setLocale('en-US');
        const { databaseBackup } = await import('@/services/DataManagementService');
        const onProgress = vi.fn();

        await databaseBackup.exportDatabase(onProgress);

        expect(saveMock).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Export settings backup',
                filters: [{ name: 'Database backup file', extensions: ['db'] }],
            })
        );
        expect(onProgress).toHaveBeenNthCalledWith(1, 'Exporting database...', 30);
        expect(onProgress).toHaveBeenNthCalledWith(2, 'Export complete', 100);
    });

    it('uses English open dialog title and filter labels when importing in English', async () => {
        setLocale('en-US');
        const { databaseBackup } = await import('@/services/DataManagementService');
        const onProgress = vi.fn();

        await databaseBackup.importDatabase('full', onProgress);

        expect(openMock).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Import settings backup',
                filters: [{ name: 'Database backup file', extensions: ['db'] }],
                multiple: false,
                directory: false,
            })
        );
        expect(onProgress).toHaveBeenNthCalledWith(1, 'Importing database...', 30);
        expect(onProgress).toHaveBeenNthCalledWith(2, 'Import complete', 100);
    });

    it('throws an English cancellation error when export is cancelled in English', async () => {
        setLocale('en-US');
        saveMock.mockResolvedValueOnce(null);
        const { databaseBackup, isDatabaseBackupCancelledError } =
            await import('@/services/DataManagementService');

        let caughtError: unknown;
        await databaseBackup.exportDatabase().catch((error: unknown) => {
            caughtError = error;
        });

        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toBe('Export cancelled');
        expect(isDatabaseBackupCancelledError(caughtError)).toBe(true);
        expect(isDatabaseBackupCancelledError({ code: 'DATABASE_BACKUP_CANCELLED' })).toBe(true);
        expect(isDatabaseBackupCancelledError(new Error('other'))).toBe(false);
    });

    it('returns an empty import result when the import dialog is cancelled', async () => {
        openMock.mockResolvedValueOnce(null);
        const { databaseBackup } = await import('@/services/DataManagementService');

        await expect(databaseBackup.importDatabase('chat_only')).resolves.toEqual({
            sourcePath: '',
            importMode: 'chat_only',
            currentBackupPath: '',
            sourceBackupPath: null,
            migratedSource: false,
        });
        expect(importBackupMock).not.toHaveBeenCalled();
    });
});
