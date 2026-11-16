import { mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { type EffectScope, effectScope, ref } from 'vue';

import { storageService } from '@/services/StorageService';
import { createInputHistorySnapshot } from '@/types/session';
import {
    createSessionInputHistoryBrowseState,
    navigateSessionInputHistory,
} from '@/views/SearchView/composables/searchInteraction';
import { useSearchAttachments } from '@/views/SearchView/composables/useSearchInput';

let scope: EffectScope | undefined;
const result = {
    removedFiles: 0,
    releasedBytes: 0,
    pendingBytes: 0,
    failedFiles: 0,
    failures: [],
    summary: {
        categories: [],
        totalBytes: 0,
        reclaimableBytes: 0,
        databaseFreeBytes: 0,
        warnings: [],
        busy: false,
    },
};
const attachment = {
    id: 'draft',
    type: 'file' as const,
    path: '/cache/file',
    originPath: '/cache/file',
    name: 'file',
};

afterEach(async () => {
    scope?.stop();
    scope = undefined;
    await flushPromises();
});

describe('given a draft contains an app-owned attachment', () => {
    it('user keeps draft content protected until removing its final attachment', async () => {
        let protectedByHost = false;
        mockTauriCommand('storage_hold', () => {
            protectedByHost = true;
            return 'draft-lease';
        });
        mockTauriCommand('storage_release', () => {
            protectedByHost = false;
        });
        mockTauriCommand('storage_cleanup', () => {
            if (protectedByHost) throw new Error('storage_busy');
            return result;
        });
        scope = effectScope();
        const draft = scope.run(() => useSearchAttachments())!;
        draft.attachments.value.push(attachment);
        await flushPromises();
        await expect(storageService.cleanup()).rejects.toThrow('storage_busy');
        draft.removeAttachment('draft');
        await flushPromises();
        await expect(storageService.cleanup()).resolves.toEqual(result);
    });

    it('user keeps an unsent attachment while browsing text-only history and can recover it before discarding the draft', async () => {
        let protectedByHost = false;
        let fileExists = true;
        mockTauriCommand('storage_hold', () => {
            protectedByHost = true;
            return 'draft-history-lease';
        });
        mockTauriCommand('storage_release', () => {
            protectedByHost = false;
        });
        mockTauriCommand('storage_cleanup', () => {
            if (protectedByHost) throw new Error('storage_busy');
            fileExists = false;
            return result;
        });
        const entries = [createInputHistorySnapshot({ text: 'older text', attachments: [] })];
        const browse = ref(createSessionInputHistoryBrowseState(entries.length));
        scope = effectScope();
        const draft = scope.run(() =>
            useSearchAttachments({
                hasRetainedAttachments: () =>
                    browse.value.pointer < entries.length &&
                    (browse.value.draftBeforeBrowse?.attachments.length ?? 0) > 0,
            })
        )!;
        draft.attachments.value.push(attachment);
        await flushPromises();
        const older = navigateSessionInputHistory({
            entries,
            currentDraft: createInputHistorySnapshot({
                text: 'unsent',
                attachments: draft.attachments.value,
            }),
            direction: 'older',
            state: browse.value,
        });
        browse.value = older.state;
        draft.attachments.value = older.nextSnapshot.attachments;
        await flushPromises();
        expect(draft.attachments.value).toEqual([]);
        await expect(storageService.cleanup()).rejects.toThrow('storage_busy');
        const newer = navigateSessionInputHistory({
            entries,
            currentDraft: older.nextSnapshot,
            direction: 'newer',
            state: browse.value,
        });
        browse.value = newer.state;
        draft.attachments.value = newer.nextSnapshot.attachments;
        await flushPromises();
        expect(draft.attachments.value[0]?.path).toBe(attachment.path);
        expect(fileExists).toBe(true);
        await expect(storageService.cleanup()).rejects.toThrow('storage_busy');
        draft.clearAttachments();
        await flushPromises();
        await expect(storageService.cleanup()).resolves.toEqual(result);
    });

    it('user can clean storage when draft protection cannot be acquired', async () => {
        mockTauriCommand('storage_hold', () => {
            throw new Error('storage_busy');
        });
        mockTauriCommand('storage_cleanup', () => result);
        scope = effectScope();
        const draft = scope.run(() => useSearchAttachments())!;
        draft.attachments.value.push(attachment);
        await flushPromises();
        await expect(storageService.cleanup()).resolves.toEqual(result);
        draft.clearAttachments();
        await flushPromises();
    });

    it('user can clean storage when releasing a draft lease fails', async () => {
        mockTauriCommand('storage_hold', () => 'draft-lease');
        mockTauriCommand('storage_release', () => {
            throw new Error('storage_io_failed');
        });
        mockTauriCommand('storage_cleanup', () => result);
        scope = effectScope();
        const draft = scope.run(() => useSearchAttachments())!;
        draft.attachments.value.push(attachment);
        await flushPromises();
        draft.clearAttachments();
        await flushPromises();
        await expect(storageService.cleanup()).resolves.toEqual(result);
    });

    it('user leaves before protection resolves and the late response does not keep storage locked', async () => {
        let protectedByHost = true;
        let finish: (id: string) => void = () => {};
        mockTauriCommand(
            'storage_hold',
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                })
        );
        mockTauriCommand('storage_release', () => {
            protectedByHost = false;
        });
        mockTauriCommand('storage_cleanup', () => {
            if (protectedByHost) throw new Error('storage_busy');
            return result;
        });
        scope = effectScope();
        const draft = scope.run(() => useSearchAttachments())!;
        draft.attachments.value.push(attachment);
        await flushPromises();
        scope.stop();
        finish('retired-draft-lease');
        await flushPromises();
        await expect(storageService.cleanup()).resolves.toEqual(result);
    });
});
