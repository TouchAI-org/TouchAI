import { storage } from '@services/NativeService/storage';
import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import { storageService, withStorageActivity } from '@/services/StorageService';

const summary = {
    categories: [],
    totalBytes: 100,
    reclaimableBytes: 20,
    databaseFreeBytes: 0,
    warnings: [],
    busy: false,
};

describe('user manages application storage', () => {
    it('user receives measured usage when refreshing storage', async () => {
        mockTauriCommand('storage_scan', summary);
        expect(await storageService.scan()).toEqual(summary);
    });

    it('user keeps recordings and logs when requesting default safe cleanup', async () => {
        mockTauriCommand('storage_cleanup', {
            removedFiles: 1,
            releasedBytes: 20,
            pendingBytes: 0,
            failedFiles: 0,
            failures: [],
            summary,
        });
        expect((await storageService.cleanup()).removedFiles).toBe(1);
        expect(getLastTauriInvokeCall('storage_cleanup')?.payload).toEqual({
            categories: ['attachments', 'clipboard', 'thumbnails', 'temporary'],
        });
    });

    it('user explicitly clears recorded history through native maintenance exclusion', async () => {
        mockTauriCommand('storage_clear_history', undefined);
        await storageService.clearHistory('messages');
        expect(getLastTauriInvokeCall('storage_clear_history')?.payload).toEqual({
            kind: 'messages',
        });
    });

    it('user releases file protection after a failed task without hiding the task error', async () => {
        mockTauriCommand('storage_hold', 'activity-1');
        mockTauriCommand('storage_release', undefined);
        await expect(
            withStorageActivity(async () => {
                throw new Error('task failed');
            })
        ).rejects.toThrow('task failed');
        expect(getLastTauriInvokeCall('storage_release')?.payload).toEqual({
            activityId: 'activity-1',
        });
    });

    it('user cannot publish an attachment after native storage refuses the operation', async () => {
        mockTauriCommand('storage_publish_attachment', () => {
            throw new Error('storage_corrupt_attachment');
        });
        await expect(storage.publishAttachment('file', '/external/document')).rejects.toThrow(
            'storage_corrupt_attachment'
        );
    });
});
