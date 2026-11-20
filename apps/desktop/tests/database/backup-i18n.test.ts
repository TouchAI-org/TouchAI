import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isDatabaseBackupCancelledError } from '@/app/api/settings/dataManagement';
import { setLocale } from '@/i18n';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
beforeEach(async () => {
    fixture = await createSettingsPanelFixture();
    setLocale('en-US');
    mockTauriCommand('plugin:dialog|save', 'D:/backup.db');
    mockTauriCommand('plugin:dialog|open', 'D:/backup.db');
});
afterEach(async () => {
    await fixture?.dispose();
    setLocale('zh-CN');
});

describe('given the settings backup client and an English app', () => {
    it('user when exporting then sees the localized picker and completed progress', async () => {
        const progress: unknown[] = [];
        await fixture.client.dataManagement!.exportDatabase((text, value) =>
            progress.push([text, value])
        );
        expect(getTauriInvokeCalls('plugin:dialog|save').at(-1)?.payload).toEqual({
            options: expect.objectContaining({
                title: 'Export data backup',
                filters: [{ name: 'Database backup file', extensions: ['db'] }],
            }),
        });
        expect(progress).toEqual([
            ['Exporting database...', 30],
            ['Export complete', 100],
        ]);
    });
    it('user when importing then sees the localized picker and completed progress', async () => {
        const progress: unknown[] = [];
        await fixture.client.dataManagement!.importDatabase('full', (text, value) =>
            progress.push([text, value])
        );
        expect(getTauriInvokeCalls('plugin:dialog|open').at(-1)?.payload).toEqual({
            options: expect.objectContaining({
                title: 'Import data backup',
                filters: [{ name: 'Database backup file', extensions: ['db'] }],
                multiple: false,
                directory: false,
            }),
        });
        expect(progress).toEqual([
            ['Importing database...', 30],
            ['Import complete', 100],
        ]);
    });
    it('user when dismissing the save picker then receives recognizable cancellation without an export', async () => {
        mockTauriCommand('plugin:dialog|save', null);
        const error = await fixture.client
            .dataManagement!.exportDatabase()
            .catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect(isDatabaseBackupCancelledError(error)).toBe(true);
        expect(isDatabaseBackupCancelledError({ code: 'DATABASE_BACKUP_CANCELLED' })).toBe(true);
        expect(isDatabaseBackupCancelledError(new Error('other'))).toBe(false);
        expect(getTauriInvokeCalls('database_export_backup')).toEqual([]);
    });
    it('user when dismissing the open picker then imports nothing', async () => {
        mockTauriCommand('plugin:dialog|open', null);
        expect(await fixture.client.dataManagement!.importDatabase('chat_only')).toBe(false);
        expect(getTauriInvokeCalls('database_import_backup')).toEqual([]);
    });
});
