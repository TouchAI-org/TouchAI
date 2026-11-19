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
    it('user opens cleanup and can read each item description before choosing what to delete', async () => {
        const dialog = await openSelection();
        expect(wrapper!.find('[data-testid="settings-storage-recordings"]').exists()).toBe(false);
        expect(wrapper!.find('[data-testid="settings-storage-compact"]').exists()).toBe(false);
        const descriptions = {
            unused: 'Unreferenced attachments, caches and unused database space',
            attachments: 'Conversation images and files; unavailable after deletion',
            clipboard: 'Copied images; deleting them may remove images used in conversations',
            thumbnails: 'Image previews in search results',
            temporary: 'Temporary screenshots and files; history links may stop working',
            recordings: 'Saved operation recordings; deletion cannot be undone',
            logs: 'App activity and crash records',
            database:
                'Conversations, usage and settings (models, providers and API keys); permanently cleared, then the app restarts',
            assets: 'Fonts and drivers; the app restarts and downloads them again when needed',
            browser: 'Sign-in state, cookies and history; closes the browser and signs you out',
        };
        for (const [category, description] of Object.entries(descriptions)) {
            const checkbox = dialog.querySelector(`[data-testid="storage-choice-${category}"]`);
            expect(checkbox).not.toBeNull();
            const descriptionId = checkbox!.getAttribute('aria-describedby');
            expect(descriptionId).toBeTruthy();
            const explanation = document.getElementById(descriptionId!);
            expect(explanation?.textContent?.trim()).toBe(description);
            expect(
                dialog.querySelector(`label[for="${checkbox!.id}"]`)?.contains(explanation!)
            ).toBe(true);
        }
        expect(dialog.textContent).not.toContain('All files in the selected categories');
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
    });

    it('user selects referenced attachments and browser data and confirms their explicit deletion', async () => {
        const dialog = await openSelection();
        choose(dialog, 'unused');
        choose(dialog, 'attachments');
        choose(dialog, 'browser');
        await flushPromises();
        expect(dialog.textContent).toContain('Conversation images and files');
        expect(dialog.textContent).toContain('signs you out');
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
        expect(dialog.textContent).toContain(
            'Conversations, usage and settings (models, providers and API keys)'
        );
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
