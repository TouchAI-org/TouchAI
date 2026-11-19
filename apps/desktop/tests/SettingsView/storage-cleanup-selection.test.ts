import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import { setLocale } from '@/i18n';
import type { StorageCategory, StorageSummary } from '@/services/NativeService/storage';
import StorageSection from '@/views/SettingsView/components/DataManagement/components/StorageSection.vue';

import { getLastTauriInvokeCall, getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';

const categories: StorageCategory[] = [
    'attachments',
    'clipboard',
    'thumbnails',
    'temporary',
    'recordings',
    'logs',
    'database',
    'assets',
    'browser',
];
const summary: StorageSummary = {
    categories: categories.map((id) => ({
        id,
        bytes: 2048,
        reclaimableBytes: ['attachments', 'clipboard', 'thumbnails', 'temporary'].includes(id)
            ? 1024
            : 0,
        fileCount: 1,
    })),
    totalBytes: 18432,
    reclaimableBytes: 4096,
    databaseFreeBytes: 1024,
    warnings: [],
    busy: false,
};

let wrapper: VueWrapper | undefined;

beforeEach(() => {
    vi.useFakeTimers();
    setLocale('en-US');
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    mockTauriCommand('storage_scan', summary);
    mockTauriCommand('storage_cleanup_selected', {
        removedFiles: 2,
        releasedBytes: 2048,
        pendingBytes: 0,
        failedFiles: 0,
        failures: [],
        summary,
    });
});

afterEach(async () => {
    wrapper?.unmount();
    toast.dismiss();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLocale('zh-CN');
});

async function openSelection() {
    wrapper = mount(StorageSection, { attachTo: document.body });
    await flushPromises();
    const button = wrapper.get('[data-testid="settings-storage-cleanup"]');
    expect(button.text()).toBe('Clean up space');
    await button.trigger('click');
    await flushPromises();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    return dialog!;
}

function choose(dialog: HTMLElement, key: string) {
    const checkbox = dialog.querySelector<HTMLButtonElement>(
        `[data-testid="storage-choice-${key}"]`
    );
    expect(checkbox, key).not.toBeNull();
    checkbox!.click();
}

describe('given every managed storage category can be explicitly removed', () => {
    it('user opens cleanup and gets one selection dialog without category action buttons', async () => {
        const dialog = await openSelection();
        expect(wrapper!.find('[data-testid="settings-storage-recordings"]').exists()).toBe(false);
        expect(wrapper!.find('[data-testid="settings-storage-compact"]').exists()).toBe(false);
        for (const category of categories) {
            expect(
                dialog.querySelector(`[data-testid="storage-choice-${category}"]`)
            ).not.toBeNull();
        }
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
    });

    it('user selects referenced attachments and browser data and confirms their explicit deletion', async () => {
        const dialog = await openSelection();
        choose(dialog, 'unused');
        choose(dialog, 'attachments');
        choose(dialog, 'browser');
        await flushPromises();
        expect(dialog.textContent).toContain('Attachments in past conversations');
        expect(dialog.textContent).toContain('sign-in');
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
        dialog.querySelector<HTMLButtonElement>('[data-testid="storage-cleanup-confirm"]')!.click();
        await flushPromises();
        expect(getLastTauriInvokeCall('storage_cleanup_selected')?.payload).toEqual({
            selection: { unused: false, categories: ['attachments', 'browser'] },
        });
    });

    it('user selects the database and can delete it after seeing the conversation and settings warning', async () => {
        const dialog = await openSelection();
        choose(dialog, 'database');
        await flushPromises();
        expect(dialog.textContent).toContain('conversations, usage and local settings');
        const confirm = dialog.querySelector<HTMLButtonElement>(
            '[data-testid="storage-cleanup-confirm"]'
        )!;
        expect(confirm.textContent).toContain('Delete and restart');
        expect(confirm.disabled).toBe(false);
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
        choose(dialog, 'attachments');
        await flushPromises();
        expect(dialog.textContent).not.toContain('Conversation text is kept.');
    });

    it('user cancels a selection and keeps every file', async () => {
        const dialog = await openSelection();
        choose(dialog, 'recordings');
        dialog.querySelector<HTMLButtonElement>('[data-testid="storage-cleanup-cancel"]')!.click();
        await flushPromises();
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
    });
});
