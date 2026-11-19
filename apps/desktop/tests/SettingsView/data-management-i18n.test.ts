import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatisticKey } from '@/database/schema';
import { setLocale } from '@/i18n';
import BadgedLogo from '@/views/SettingsView/components/AiServices/components/BadgedLogo.vue';
import ImportModeDialog from '@/views/SettingsView/components/DataManagement/components/ImportModeDialog.vue';
import ProgressDialog from '@/views/SettingsView/components/DataManagement/components/ProgressDialog.vue';
import DataManagement from '@/views/SettingsView/components/DataManagement/index.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: VueWrapper[] = [];
beforeEach(async () => {
    fixture = await createSettingsPanelFixture();
    setLocale('en-US');
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    mockTauriCommand('analytics_get_state', {
        status: 'disabled',
        consentEpoch: 0,
        queueDepth: 0,
        pendingBytes: 0,
        buildEligible: false,
        transportReady: false,
    });
    mockTauriCommand('obs_diagnostic_mode_status', { enabled: false, expiresAtMs: 0 });
    mockTauriCommand('obs_preview_bundle', { files: [], totalBytes: 0, truncated: false });
});
afterEach(async () => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    await fixture?.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLocale('zh-CN');
});

describe('given the actual settings data panel in English', () => {
    it('user when opening data management then sees translated sections and the saved metadata freshness', async () => {
        fixture.database
            .prepare('INSERT INTO statistics (key, value) VALUES (?, ?)')
            .run(StatisticKey.MODEL_METADATA_LAST_UPDATED_AT, '2026-05-20T12:34:00Z');
        const wrapper = mount(DataManagement, fixture.viewOptions);
        wrappers.push(wrapper);
        await flushPromises();
        for (const text of [
            'Data & privacy',
            'Data statistics',
            'Conversation sessions',
            'Clear all conversation history',
            'Data updates',
            'Model database',
            'Last updated:',
            'Data backup & restore',
            'Export backup',
            'Import backup',
            'Diagnostics and support',
            'Privacy and product analytics',
            'Clear',
            'Update',
            'Export',
            'Import',
        ]) {
            expect(wrapper.text()).toContain(text);
        }
        expect(wrapper.text().indexOf('Diagnostics and support')).toBeLessThan(
            wrapper.text().indexOf('Privacy and product analytics')
        );
        expect(wrapper.text()).toMatch(/May|5/);
        expect(wrapper.text()).not.toContain('最近更新');
        expect(wrapper.text()).not.toContain('数据与隐私');
    });

    it('user when viewing a built-in provider then sees an untruncated localized badge', () => {
        const wrapper = mount(BadgedLogo, {
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

    it('user when opening import choices then sees translated wrapping-safe option buttons', async () => {
        const wrapper = mount(ImportModeDialog, {
            props: { isLoading: false },
            attachTo: document.body,
        });
        wrappers.push(wrapper);
        await flushPromises();
        const dialog = document.querySelector('[role=dialog]')!;
        expect(dialog.textContent).toContain('Choose import mode');
        expect(dialog.textContent).toContain('Import conversation data only');
        expect(dialog.textContent).toContain('Overwrite settings and import conversations');
        expect(dialog.textContent).not.toContain('选择导入模式');
        for (const button of [...dialog.querySelectorAll('button')].slice(0, 2))
            expect(button.classList.contains('whitespace-normal')).toBe(true);
    });

    it('user when reading long progress paths then sees wrapping and the completed percentage', async () => {
        const wrapper = mount(ProgressDialog, {
            props: {
                title: 'Database exported',
                message:
                    'E:/very/long/backup/path/with/many/segments/touchai-settings-backup-2026-05-22.db',
                progress: 42,
                status: 'success',
                dismissible: true,
            },
            attachTo: document.body,
        });
        wrappers.push(wrapper);
        await flushPromises();
        const message = document.querySelector('[data-testid="progress-message"]')!;
        expect(message.classList.contains('break-words')).toBe(true);
        expect(message.classList.contains('whitespace-normal')).toBe(true);
        expect(message.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
        expect(document.querySelector('[role=dialog]')?.textContent).toContain('42%');
    });

    it('user when importing from the panel then persists source restart-notice bytes and relaunches only after the countdown', async () => {
        mockTauriCommand('plugin:dialog|open', '/fixture/import.db');
        const wrapper = mount(DataManagement, fixture.viewOptions);
        wrappers.push(wrapper);
        await flushPromises();
        vi.useFakeTimers();
        await wrapper
            .get('[data-settings-search-target="import-settings"] button')
            .trigger('click');
        await flushPromises();
        const option = [
            ...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button'),
        ].find((button) => button.textContent?.includes('Overwrite settings'))!;
        option.click();
        await flushPromises();
        expect(
            fixture.database
                .prepare('SELECT value FROM touchai_meta WHERE key = ?')
                .get('import_success')?.value
        ).toBe(JSON.stringify({ type: 'import-success', version: 1, importMode: 'full' }));
        expect(document.querySelector('[data-testid="progress-message"]')?.textContent).toContain(
            '3'
        );
        expect(getTauriInvokeCalls('plugin:process|restart')).toEqual([]);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(getTauriInvokeCalls('plugin:process|restart')).toHaveLength(1);
    });
});
