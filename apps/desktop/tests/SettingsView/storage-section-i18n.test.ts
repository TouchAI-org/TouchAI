import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import { type AppLocale, setLocale, t } from '@/i18n';
import { messages } from '@/i18n/messages';
import type { StorageCategory, StorageSummary } from '@/services/NativeService/storage';
import { STORAGE_SETTINGS_SEARCH_ITEMS } from '@/services/SettingsService/domain/sections/registry';
import StorageSection from '@/views/SettingsView/components/DataManagement/components/StorageSection.vue';
import { searchSettings } from '@/views/SettingsView/settingsSearch';

import { mockTauriCommand } from '../utils/tauri';

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
    categories: categories.map((id) => ({ id, bytes: 1024, reclaimableBytes: 1024, fileCount: 1 })),
    totalBytes: 9 * 1024,
    reclaimableBytes: 4 * 1024,
    databaseFreeBytes: 1024,
    busy: false,
    warnings: [],
};

let wrapper: VueWrapper | undefined;
let host: HTMLDivElement;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    host = document.createElement('div');
    document.body.appendChild(host);
    mockTauriCommand('storage_scan', () => summary);
    mockTauriCommand('storage_cleanup', () => ({
        removedFiles: 1,
        releasedBytes: 1024,
        pendingBytes: 512,
        failedFiles: 1,
        failures: [{ path: 'fixture/locked.tmp', code: 'storage_io_failed' }],
        summary,
    }));
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    host.remove();
    toast.dismiss();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLocale('zh-CN');
});

describe('given storage settings are available in either supported interface language', () => {
    it.each([
        [
            'en-US',
            'Storage',
            'Clean up 4 KiB',
            'Free up database space',
            'Delete recordings',
            'Delete logs',
            'Refresh',
        ],
        ['zh-CN', '存储空间', '清理 4 KiB', '释放数据库空间', '删除录制文件', '删除日志', '刷新'],
    ] as const)(
        'user opens storage in %s and reads localized categories and actions',
        async (locale, title, safeCleanup, compact, recordings, logs, refresh) => {
            setLocale(locale);
            wrapper = mount(StorageSection, { attachTo: host });
            await flushPromises();

            expect(wrapper.text()).toContain(title);
            expect(wrapper.text()).toContain(safeCleanup);
            for (const [action, label] of Object.entries({ compact, recordings, logs, refresh })) {
                const control = wrapper.get(`[data-testid="settings-storage-${action}"]`);
                expect(control.text()).toBe('');
                expect(control.attributes('title')).toContain(label);
                expect(control.attributes('aria-label')).toContain(label);
            }
            expect(wrapper.text()).not.toContain('settings.storage.');
            for (const category of categories) {
                expect(
                    wrapper.get(`[data-testid="settings-storage-category-${category}"]`).text()
                ).toContain(messages[locale][`settings.storage.category.${category}`]);
            }
        }
    );

    it('user switches language after cleanup and the retained results and failures change language', async () => {
        setLocale('en-US');
        wrapper = mount(StorageSection, { attachTo: host });
        await flushPromises();
        await wrapper.get('[data-testid="settings-storage-cleanup"]').trigger('click');
        await flushPromises();
        const dialog = document.querySelector<HTMLElement>('[role=alertdialog]')!;
        const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent?.trim() === 'Clean up'
        );
        expect(confirm).toBeDefined();
        confirm!.click();
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-storage-result"]').text()).toContain(
            'Files removed: 1. Observed release: 1 KiB. Estimated pending release: 512 B. Failed files: 1.'
        );

        setLocale('zh-CN');
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-storage-result"]').text()).toContain(
            '已删除 1 个文件，检测到释放 1 KiB，预计待释放 512 B，失败 1 个文件。'
        );
        const failures = wrapper.get('[data-testid="settings-storage-failures"]');
        expect(failures.text()).toContain('部分存储文件无法读取或删除。');
        expect(failures.text()).not.toContain('Some storage files');
    });

    it.each(['en-US', 'zh-CN'] as const)(
        'user reads a native storage refusal in %s without raw error codes',
        async (locale) => {
            setLocale(locale);
            mockTauriCommand('storage_scan', () =>
                Promise.reject({ code: 'storage_invalid_path' })
            );
            wrapper = mount(StorageSection, { attachTo: host });
            await flushPromises();

            expect(wrapper.get('[data-testid="settings-storage-error"]').text()).toBe(
                t('settings.storage.errors.invalidPath')
            );
            expect(wrapper.text()).not.toContain('storage_invalid_path');

            setLocale(locale === 'en-US' ? 'zh-CN' : 'en-US');
            await flushPromises();
            expect(wrapper.get('[data-testid="settings-storage-error"]').text()).toBe(
                t('settings.storage.errors.invalidPath')
            );
        }
    );

    it.each(['en-US', 'zh-CN'] as const)(
        'user chooses a full backup in %s and gets a localized archive filter label',
        (locale) => {
            setLocale(locale);
            expect(t('database.backup.dialog.fullFilterName')).toBe(
                locale === 'en-US' ? 'Full TouchAI backup' : 'TouchAI 完整备份'
            );
        }
    );

    it('user reads storage notices in either language with the same interpolation information', () => {
        const keys = Object.keys(messages['zh-CN']).filter((key) =>
            key.startsWith('settings.storage.')
        );
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) {
            const messageKey = key as keyof (typeof messages)['zh-CN'];
            const chinese = messages['zh-CN'][messageKey];
            const english = messages['en-US'][messageKey];
            expect(chinese.trim(), key).not.toBe('');
            expect(english.trim(), key).not.toBe('');
            const chineseParameters = new Set(
                [...chinese.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
            );
            const englishParameters = new Set(
                [...english.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
            );
            expect([...chineseParameters].sort()).toEqual([...englishParameters].sort());
        }
    });
});

describe('given storage actions are registered for settings navigation', () => {
    it('user follows a registered storage search target and finds the corresponding visible row', async () => {
        setLocale('en-US');
        wrapper = mount(StorageSection, { attachTo: host });
        await flushPromises();

        for (const item of STORAGE_SETTINGS_SEARCH_ITEMS) {
            const target = wrapper.get(`[data-settings-search-target="${item.targetId}"]`);
            expect(target.isVisible(), item.targetId).toBe(true);
            expect(target.element.closest('details:not([open])'), item.targetId).toBeNull();
        }
    });

    it.each([
        ['zh-CN', 'disk space', 'storage'],
        ['en-US', '存储空间', 'storage'],
        ['zh-CN', 'VACUUM', 'storage-compaction'],
        ['en-US', '安全清理', 'storage-cleanup'],
        ['en-US', '录制', 'storage-recordings'],
        ['zh-CN', 'logs', 'storage-logs'],
    ] as const)(
        'user searches in %s for %s and can navigate to the storage action',
        (locale: AppLocale, query, targetId) => {
            setLocale(locale);
            expect(searchSettings(query)).toContainEqual(
                expect.objectContaining({ section: 'data-management', targetId })
            );
        }
    );
});
