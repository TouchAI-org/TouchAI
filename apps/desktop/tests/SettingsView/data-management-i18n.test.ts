import type { DatabaseQueryRequest } from '@services/NativeService/database';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import { MetaKey, StatisticKey } from '@/database/schema';
import { setLocale } from '@/i18n';
import BadgedLogo from '@/views/SettingsView/components/AiServices/components/BadgedLogo.vue';
import BackupScopeDialog from '@/views/SettingsView/components/DataManagement/components/BackupScopeDialog.vue';
import ProgressDialog from '@/views/SettingsView/components/DataManagement/components/ProgressDialog.vue';
import DataManagement from '@/views/SettingsView/components/DataManagement/index.vue';

import { getLastTauriInvokeCall, mockTauriCommand } from '../utils/tauri';

let pinia: ReturnType<typeof createPinia>;
let host: HTMLDivElement;
const wrappers: VueWrapper[] = [];
const storedMeta = new Map<string, string>();

function dialog() {
    const element = document.querySelector<HTMLElement>('[role=dialog]');
    expect(element).not.toBeNull();
    return element!;
}

beforeEach(() => {
    vi.useFakeTimers();
    pinia = createPinia();
    setLocale('zh-CN');
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    host = document.createElement('div');
    document.body.appendChild(host);
    storedMeta.clear();
    mockTauriCommand('database_query', (payload: unknown) => {
        const { request } = payload as { request: DatabaseQueryRequest };
        let rows: Array<Record<string, unknown>> = [];
        if (request.sql.includes('count(')) {
            const count = request.sql.includes('from "sessions"')
                ? 1
                : request.sql.includes('from "messages"')
                  ? 2
                  : 3;
            rows = [{ count }];
        } else if (request.sql.includes('from "statistics"')) {
            rows = [
                {
                    id: 1,
                    key: StatisticKey.MODEL_METADATA_LAST_UPDATED_AT,
                    value: '2026-05-20T12:34:00Z',
                    created_at: '',
                    updated_at: '',
                },
            ];
        } else if (request.sql.includes('insert into "touchai_meta"')) {
            storedMeta.set(String(request.params?.[0]), String(request.params?.[1]));
        }
        return { rows, rowsAffected: 0, lastInsertId: null };
    });
    mockTauriCommand('storage_scan', () => ({
        categories: [],
        totalBytes: 0,
        reclaimableBytes: 0,
        databaseFreeBytes: 0,
        warnings: [],
        busy: false,
    }));
    mockTauriCommand('analytics_get_state', () => ({
        status: 'disabled',
        consentEpoch: 0,
        queueDepth: 0,
        pendingBytes: 0,
        buildEligible: false,
        transportReady: false,
    }));
    mockTauriCommand('obs_diagnostic_mode_status', () => ({ enabled: false, expiresAtMs: 0 }));
    mockTauriCommand('obs_preview_bundle', () => ({ files: [], totalBytes: 0, truncated: false }));
});

afterEach(async () => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    disposePinia(pinia);
    host.remove();
    toast.dismiss();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLocale('zh-CN');
});

describe('given local data settings and dialogs are displayed in English', () => {
    it('user opens data settings and sees model metadata dates and the additive storage section localized', async () => {
        setLocale('en-US');
        const wrapper = mount(DataManagement, {
            attachTo: host,
            global: { plugins: [pinia] },
        });
        wrappers.push(wrapper);
        await flushPromises();

        expect(wrapper.text()).toContain('Data & privacy');
        expect(wrapper.text()).toContain('Data statistics');
        expect(wrapper.text()).toContain('Conversation sessions');
        expect(wrapper.text()).toContain('Storage');
        expect(wrapper.text()).toContain('Clear all conversation history');
        expect(wrapper.text()).toContain('Data updates');
        expect(wrapper.text()).toContain('Model database');
        expect(wrapper.text()).toContain('Last updated:');
        expect(wrapper.text()).toContain('Data backup & restore');
        expect(wrapper.text()).toContain('Export backup');
        expect(wrapper.text()).toContain('Import backup');
        expect(wrapper.text()).toContain('Diagnostics and support');
        expect(wrapper.text()).toContain('Privacy and product analytics');
        expect(wrapper.text().indexOf('Diagnostics and support')).toBeLessThan(
            wrapper.text().indexOf('Privacy and product analytics')
        );
        expect(wrapper.text()).toContain('Clear');
        expect(wrapper.text()).toContain('Update');
        expect(wrapper.text()).toContain('Export');
        expect(wrapper.text()).toContain('Import');
        expect(wrapper.text()).toMatch(/May|5/);
        expect(wrapper.text()).not.toContain('最近更新');
        expect(wrapper.text()).not.toContain('数据与隐私');
    });

    it('user opens a built-in provider and its localized badge does not truncate longer labels', () => {
        setLocale('en-US');
        const wrapper = mount(BadgedLogo, {
            attachTo: host,
            props: { logo: 'missing-provider.svg', name: 'Built In Provider', showBadge: true },
        });
        wrappers.push(wrapper);
        const badge = wrapper.get('[data-testid="provider-built-in-badge"]');

        expect(badge.text()).toBe('Built-in');
        expect(badge.classes()).toContain('whitespace-nowrap');
        expect(badge.classes()).toContain('min-w-max');
        expect(badge.classes()).not.toContain('truncate');
        expect(badge.classes()).not.toContain('max-w-[4.5rem]');
    });

    it('user opens a full backup and can select either localized content group', async () => {
        setLocale('en-US');
        const wrapper = mount(BackupScopeDialog, {
            attachTo: host,
            props: { isLoading: false, action: 'import', available: 'full', open: true },
        });
        wrappers.push(wrapper);
        await flushPromises();
        const choices = dialog();

        expect(choices.textContent).toContain('Import backup');
        expect(
            choices
                .querySelector('[role=switch][aria-label="Settings"]')
                ?.getAttribute('aria-checked')
        ).toBe('true');
        expect(
            choices.querySelector('[role=switch][aria-label="Data"]')?.getAttribute('aria-checked')
        ).toBe('true');
        expect(choices.textContent).toContain('provider credentials');
    });

    it('user reads a long backup path and the progress message can wrap without losing the progress value', async () => {
        const wrapper = mount(ProgressDialog, {
            attachTo: host,
            props: {
                title: 'Database exported',
                message:
                    'E:\\very\\long\\backup\\path\\with\\many\\segments\\touchai-backup-2026-05-22.zip',
                progress: 42,
                status: 'success',
                dismissible: true,
            },
        });
        wrappers.push(wrapper);
        await flushPromises();
        const message = document.querySelector('[data-testid="progress-message"]')!;
        expect(message).not.toBeNull();

        expect(message.classList).toContain('break-words');
        expect(message.classList).toContain('whitespace-normal');
        expect(message.classList).toContain('[overflow-wrap:anywhere]');
        expect(dialog().textContent).toContain('42%');
    });

    it('user imports settings and the persisted startup notice retains a source payload for the next language', async () => {
        setLocale('en-US');
        mockTauriCommand('plugin:dialog|open', () => 'fixture-backup.zip');
        mockTauriCommand('database_backup_scope', 'full');
        mockTauriCommand('database_import_backup', () => undefined);
        const wrapper = mount(DataManagement, {
            attachTo: host,
            global: { plugins: [pinia] },
        });
        wrappers.push(wrapper);
        await flushPromises();
        await wrapper
            .get('[data-settings-search-target="import-settings"] button')
            .trigger('click');
        await flushPromises();
        const fullImport = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent?.trim() === 'Import'
        );
        expect(fullImport).toBeDefined();
        fullImport!.click();
        await flushPromises();

        expect(storedMeta.get(MetaKey.IMPORT_SUCCESS)).toBe(
            JSON.stringify({
                type: 'import-success',
                version: 1,
                importMode: 'full',
            })
        );
        expect(storedMeta.get(MetaKey.IMPORT_SUCCESS)).not.toContain('Data imported successfully');
        expect(getLastTauriInvokeCall('database_import_backup')?.payload).toEqual({
            request: { sourcePath: 'fixture-backup.zip', mode: 'full' },
        });
    });
});
